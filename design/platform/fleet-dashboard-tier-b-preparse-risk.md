# 大盘 B 档「写入时预解析」风险评估

> 状态：待评审 · 2026-07-21
> 决策背景：B 档面板（per-tool 统计、模型 per-call 耗时分位、失败原因分类、平均执行步数、慢表模型调用均耗时列）需要 Session.interactions 里的 per-call 数据。已否决「请求时现解析 + cap 采样」（大盘 30s 自动刷新会反复解析大 JSON，重蹈 consumer CPU 烧满覆辙；分位数变采样值）。本文评估「写入时预解析 + 历史回填」方案在大并发、大 trace 下的资源风险与坑位，**评审通过后再动工**。

## 1. 挂钩点盘点（已核实代码）

所有框架的 Execution/Session 写入最终汇聚到**同一个漏斗**：`saveExecutionRecord`（[data-service.ts:2179](../../src/lib/storage/data-service.ts)）。已确认的上游入口：

| 入口 | 路径 | 说明 |
|---|---|---|
| 上传 API | `api/ingest/upload/route.ts`（3 处调用） | opencode/hermes/langfuse 等上报 |
| OTel consumer | `lib/ingest/otel-consumer/consumer.ts:107` | spool 消费（可注入,默认 saveExecutionRecord） |
| jiuwen 聚合 | `lib/ingest/otel/jiuwen/aggregate.ts` | 注释明确写 saveExecutionRecord 收口 |
| 代理结束 | `api/ingest/proxy/[taskId]/end` | proxy 会话落库 |
| 其他 | openclaw-watcher / rejudge / debug / seed | 低频路径 |

**关键事实**：漏斗内的 `mergedInteractionsForSession` 是**已在内存中的对象数组**（随后才 `JSON.stringify` 落库）。摘要计算挂在此处 = **零额外 JSON.parse**，增量成本仅一次 O(interactions 长度) 顺序遍历。这与「读回来再解析」有本质区别——后者才是 consumer 事故的模式。

## 2. 摘要列设计（本方案最大的风险决策点）

### 反面方案：存原始 per-call 数组 ❌

`[[model, ms], ...]` 体积随 trace 线性增长（本地实测 llmCallCount max=244 → 单行 ~10KB；生产更大 trace 无上界）。大盘 30 天窗口查询数千行 → 数十 MB 读取 + 数千次 parse，把「大 JSON 问题」从 Session 搬到了 Execution，白改。

### 推荐方案：固定体积可合并摘要 ✅

新增 `Execution.callStats`（TEXT，可空），结构版本化：

```jsonc
{
  "v": 1,
  "steps": 42,               // interactions 轮次（平均执行步数用）
  "truncated": false,        // 触发护栏截断时置 true
  "llm": {                   // 按模型；键数上限 30，超出并入 "__other"
    "deepseek-v4": { "n": 21, "errN": 0, "sumMs": 58200, "unkN": 0, "hist": [0,3,8,6,4,0, ...] }
  },
  "tool": {                  // 按真实工具名；键数上限 50，超出并入 "__other"
    "execute_command": { "n": 15, "errN": 2, "sumMs": 10300, "unkN": 0, "hist": [ ... ] }
  },
  "errTypes": { "timeout": 2, "网络/连接": 1 }   // 关键词规则归类，规则集中一个函数
}
```

- **hist = 对数桶直方图**（模型 20 桶、工具 12 桶，边界 2 倍递增覆盖 10ms～20min+）。直方图**可跨 trace 直接相加合并**，端点合并后按桶内线性插值估分位——这是"分位数无法跨行合并"问题的标准解。误差 ≤ 桶宽（约 ±30% 上界、实际远小），前端 hint 注明「直方图估算」。
- **体积上界恒定**：30 模型×20 桶 + 50 工具×12 桶 ≈ **2–4KB/行**，与 trace 大小无关。本地 1034 行 ≈ 4MB 存储增量，可忽略。
- `unkN`：该框架无 per-call 耗时字段时计数（不进直方图）——各框架埋点覆盖不同（claude-otel 有 `duration_ms`、langfuse 有 `latency`、部分无），端点据此输出覆盖率，避免静默偏差。

## 3. 风险清单与缓解（对照三次历史事故）

| # | 风险 | 评估 | 缓解 |
|---|---|---|---|
| R1 | **写入路径 CPU 放大**（consumer 恒 101% 事故重演） | 挂钩点对象已在内存，无 parse；jiuwen/consumer 已有「会话冷却+全局串行+增量读」三重闸，摘要包在既有重聚合动作内，**不新增触发频率**。单遍 O(n)：244 次调用的 trace ≈ 微秒级 | 护栏：interactions > 10,000 条 → 只统计前 10,000 并置 `truncated`；纯迭代无递归；不做任何二次排序（直方图天然免排序） |
| R2 | **大 trace 内存**（8MB 帧上限 / 堆 OOM 教训） | 摘要计算不复制数组、不 stringify 中间态，峰值内存不高于现状；摘要对象本身 O(模型数+工具数) 固定 | 超大 session 的既有风险由 spool/snapshot 护栏管，本方案不放大；R1 的条数护栏同时兜内存 |
| R3 | **存储膨胀** | 固定 2–4KB/行（见 §2） | 键数上限 30/50 是硬护栏，恶意/异常工具名基数打不爆体积 |
| R4 | **查询路径**（大盘 30s 刷新 × 多用户） | 30 天窗口数千行 × 3KB ≈ 10MB 内、数千次**小** JSON.parse ≈ 10ms 级；对比被否决方案（每请求 parse 200 个平均 71KB、最大 2.1MB 的 session）优 2–3 个数量级 | breakdowns 维持懒加载；后续如行数过万可加 LRU（窗口+用户键，30s TTL），先不做 |
| R5 | **回填脚本**（一次性扫全量 Session） | 本地 1091 条 avg 71KB / max 2.1MB；生产未知，按曾出现 8MB 级预估 | 独立 CLI **手动执行**（绝不随服务启动自动跑）；分批 50 条 + 批间 sleep 200ms；游标断点续跑（只处理 `callStats IS NULL`）；单条 try/catch 跳过记日志；执行前提示备份 DB |
| R6 | **schema 迁移 / 部署顺序**（记忆教训：schema 变更必须连代码一起重启，不可热替换） | 新列可空，旧代码零感知 | 顺序：① migrate 加列（旧代码兼容）→ ② 部署新代码并**重启**（含 consumer）→ ③ 手动回填。回滚 = 回滚代码即可，列留存无害 |
| R7 | **摘要失败阻断主写入** | 不可接受 | 摘要计算整体 try/catch，失败写 null，Execution 主流程照常；面板显示覆盖率「N/M trace 有统计」 |
| R8 | **upsert 幂等性**（session 增量重聚合会反复触发） | 每次基于**全量** interactions 重算、整列覆盖——幂等，无增量累加的漂移风险 | 刻意选全量重算而非增量累加；与既有 llmCallCount 等列的覆盖语义一致，无新增竞态面 |
| R9 | **OpenGauss / SQLite 双方言** | db 层已有双后端抽象与降级先例（ExecutionSkill 的 OpenGauss 降级） | 新列走 prisma 标准 TEXT；回填脚本用 db 层接口不裸写 SQL |
| R10 | **失败原因分类的口径漂移** | 关键词规则主观 | 规则表集中单函数 + 单测钉住样例；未命中归「其他」并保留 top 原始 error 词条供迭代规则 |

## 4. 实测数据支撑（本地 dev 库 `~/.agent-insight/data/witty_insight.db`）

- Session：1091 条，interactions avg **71KB**、max **2.1MB**，>1MB 仅 1 条（生产按 8MB 级预估护栏）。
- Execution：llmCallCount avg 4.1 / max 244；toolCallCount max 227 → 单行遍历成本微小，直方图 20 桶绰绰有余。

## 5. 分期实施（每步独立可验证）

1. **PR-B1**：schema 加列 + `computeCallStats(interactions)` 纯函数 + 挂钩 saveExecutionRecord + 单测（含 10k 条超大构造件、字段缺失件、键基数爆炸件、幂等重算件）。
2. **PR-B2**：回填 CLI（`scripts/backfill-call-stats.ts`）+ 断点/批次/日志。
3. **PR-B3**：trends/breakdowns/agent 端点消费摘要（直方图合并+分位插值 helper 进 agg.ts）+ 前端点亮全部 B 档面板（替换占位卡）+ 慢表「模型调用均耗时」列。

## 6. 开放问题（评审时定）

1. 直方图桶边界定稿（拟：模型 `[0,100ms,200,400,...,~20min,+∞]` 20 桶；工具 `[0,20ms,50,100,...,~2min,+∞]` 12 桶）。
2. 失败原因分类初始规则集（拟沿用高保真：timeout / 命令非零退出 / 网络连接 / 权限拒绝 / 参数校验 / 上下文超限 / 限流 429 / 其他）。
3. 回填是否要在生产跑（还是只回填最近 30 天——大盘窗口最长 30 天，更早的历史回填收益为零，**建议只回填 30 天**，把 R5 风险再砍一个量级）。
