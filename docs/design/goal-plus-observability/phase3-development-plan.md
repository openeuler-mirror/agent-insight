# Goal Plus 观测接入：开发计划

- 状态：提案
- 关联文档：[Phase 1](phase1-requirements-analysis.md) / [Phase 2](phase2-requirements-design.md)
- 基线提交：`679630181999`
- 最后更新：2026-09-02

## 1. 交付策略

实施分为六个 wave。先用真实但脱敏的 Goal Plus fixture 固化外部数据契约，再实现
只读 parser 和 Pi passive importer；随后落服务端模型/API、关联与 UI。任何 wave 都
不得要求 Goal Plus 改代码。

MVP 定义：

- attach/scan 一个 `.gp`；
- Goal/run/candidate/iteration 可入库；
- Codex Execution 可确定关联；
- Goal Plus Pi worker 可从 native session 生成 Execution；
- 查询 API 返回 composite trace 和 completeness；
- UI 可以从 Goal 下钻 candidate native trace。

## 2. 开发波次

```text
Wave 0  外部契约与测试基线
   │
   ├── Wave 1  本地 source/semantic collector
   ├── Wave 2  Pi native passive importer
   │               │
   └───────────────┴──> Wave 3  Prisma + ingest + correlation
                               │
                               ▼
                         Wave 4  Query + UI + completeness
                               │
                               ▼
                         Wave 5  安装、文档、真实验收
```

Wave 1 和 Wave 2 可以在 Wave 0 完成后并行。Wave 3 需要前两者的稳定 envelope 与
identity。Wave 4 依赖服务端投影。Wave 5 完成分发和真实宿主验收。

## 3. 任务清单

### Wave 0：事实样本与基线

- [ ] T001 建立 Goal Plus fixture 集
  - 从最小 Goal Mode、Codex Search、Pi Search、run invalidation/successor、final
    checker 各取一套脱敏结构样本；
  - fixture 只保留 schema 结构、合成正文、相对路径和虚构 hash；
  - 覆盖 `goal.json`、goal events、frozen spec、run、candidate、agent session、
    best、promotion/report metadata 和 Pi native session；
  - 不提交用户真实 prompt、workspace、绝对路径、credential 或 hidden-answer 数据。
  - 验收：fixture 能表达 Phase 1 所有 user stories，并明确每个来源的 Goal Plus/Pi
    版本。

- [ ] T002 固化 schema compatibility matrix
  - 记录当前 Goal Plus model 字段和 Pi native session entry 形状；
  - 对缺失 `schema_version` 的现有 snapshot 定义结构特征检测；
  - 定义 unknown optional、unknown required 和 unsupported 行为；
  - 验收：每种 fixture 都命中唯一 parser version，未知关键形状确定性拒绝。

- [ ] T003 修复 Pi adapter Skill 映射基线
  - 先复现现有两项 `pi-agent-adapter.test.ts` 失败；
  - 修复不能改变非 Goal Plus Pi trace 的已有 interactions 和 snapshot-replace 语义；
  - 验收：Pi adapter/collector 定向测试全绿。

### Wave 1：Goal Plus 本地 collector

- [ ] T101 source registry 与路径安全
  - 实现 `attach/list/detach`、随机 source ID、canonical root 去重；
  - 只允许普通文件和显式 root，拒绝 symlink/path traversal；
  - detach 只能删除 Agent Insight managed config/checkpoint；
  - 测试相同 root 重复 attach、root move、恶意 relative path、symlink 和权限错误。

- [ ] T102 稳定 snapshot/JSONL reader
  - 实现前后 stat、半写重试、hash、完整换行、offset/checkpoint；
  - 支持 snapshot 原子替换和 Pi session append/replace；
  - 测试 truncate、rename、尾部坏行、并发写和 collector crash 恢复。

- [ ] T103 Goal Plus semantic parser
  - 按 allowlist 解析 goal/spec/run/candidate/iteration/agent session/best/report meta；
  - 生成 versioned snapshot envelope；
  - 实现 bounded/metadata-only 两种 content mode；
  - 对 snapshot 做 Goal/run/candidate/iteration 交叉一致性诊断；
  - 验收：fixture 的 normalized snapshots 使用 golden JSON 断言。

- [ ] T104 semantic spool/uploader
  - 复用现有 API-key namespace、atomic rename、lock、retry/backoff 模式；
  - 实现 batch limit、checkpoint 仅在服务端确认后前移、rejected/dead-letter；
  - 日志只记录 source/object/snapshot ID 和错误类别，不记录正文/API key；
  - 验收：500/429/断网/重启无丢失、无重复 checkpoint 前移。

- [ ] T105 collector CLI 与 self-check
  - 实现 `scan/watch/self-check`；
  - self-check 输出 source root 可读性、对象计数、parser version、Pi session coverage、
    spool backlog 和最近错误；
  - foreground watch 可正常停止，不遗留无跟踪后台进程。

### Wave 2：Pi native passive importer

- [ ] T201 Pi session locator
  - 从 agent session metadata、launch session dir、受限 fallback 目录定位 native file；
  - 从 attached workspace 精确推导 Pi project-session 目录，以 native entry/goal ID 定位
    Goal Plus 主对话，并按 invocation marker 分段；
  - 多匹配、root 外路径和 symlink 进入 unresolved；
  - 使用 file fingerprint，不上传绝对路径。

- [ ] T202 Pi native parser
  - 解析所有 user/custom/assistant thinking+text/toolCall/toolResult/error/usage/model/provider/timestamp；
  - native 正文仅脱敏、不做固定字符截断；单条大 JSONL 超过 batch byte target 时独立上传；
  - unknown entry 只做 bounded diagnostic；
  - tool/MCP/Skill 分类复用现有 Pi helper，不能复制并漂移另一套分类逻辑；
  - 输出 canonical events，并标记 timing/content fidelity；
  - 验收：native fixture 生成 user、LLM、Tool、Skill、MCP 和 usage golden events。

- [ ] T203 continuation 与 snapshot-replace
  - canonical session ID 固定为 source + Goal Plus agent session；
  - session append 后重建完整 canonical snapshot；
  - event ID 对相同 native entry 稳定；
  - 验收：三次 continuation 始终只有一个 Execution，interactions 不重复，usage 不
    累加两次。

- [ ] T204 native OTLP spool 接线
  - 复用 shared trace transport 上传到现有 OTLP endpoint；
  - resource/span attributes 携带 allowlisted `goal_plus.*` identity；
  - 不改 generic/Codex/Pi 非 Goal Plus事件结果；
  - 验收：现有 `pi-agent` adapter 聚合 passive events 为完整 ExecutionRecord。

- [ ] T205 fidelity 与降级
  - session 缺失、unknown schema、summary-only、derived timing 分别产生明确诊断；
  - 不根据 compact RPC log 伪造正文/tool 参数；
  - 验收：每种降级都返回预期 completeness/missing category。

- [ ] T206 主对话、全 worker 与终止状态
  - Goal active session 记录所有已发现 Pi main invocation 的 canonical session ID；
  - `pi-rpc`、`pi`、`pi-agent` 的每个可定位 agent session 都进入 importer；
  - worker timeout、runner failure、未恢复的 runtime aborted/cancelled/blocked、non-zero exit 生成失败证据；Goal/Run 业务 blocked 不改变主 Execution 的运行结果；
  - 验收：主对话可见，worker 数与 `.gp/runs/*/agent_sessions` 一致，长正文长度一致。

### Wave 3：服务端模型、API 与关联

- [ ] T301 Prisma schema/migration
  - 新增 Phase 2 定义的 source/goal/run/candidate/iteration/agent session/link/snapshot
    模型；
  - 为 user+source、run、candidate、agent session、snapshot、link state 建索引；
  - 不修改现有 Execution parent/root 语义；
  - 验收：空库迁移、已有库迁移、唯一约束和级联行为测试通过。

- [ ] T302 semantic contract 和 route validation
  - 新增共享 TypeScript contract、batch/body limits、version 校验和 server-side
    redaction/path defense；
  - API user 归属只取已认证 API key；
  - 单项失败可报告，重试语义稳定；
  - 验收：auth、oversize、duplicate、unknown version、malformed payload 测试通过。

- [ ] T303 snapshot persistence/projection
  - snapshot audit 和 current projection 在单项事务内写入；
  - 支持 parent 乱序和 pending replay；
  - source snapshot 不能覆盖用户 label 和服务端 link；
  - 验收：任意打乱 fixture 上传顺序，最终 projection 相同。

- [ ] T304 correlation service
  - 实现 native session、agent session attribute、active session、task name、fingerprint
    方法及优先级；
  - 限定同 user/source，歧义不自动选择；
  - 新 Execution、新 snapshot 和手动 relink 均可触发；
  - 验收：Codex main/work item/candidate 和 Pi passive execution 全部正确关联，构造的
    同名 task 保持 ambiguous。

- [ ] T305 authoritative execution 选择
  - 实现 Pi extension > Pi native passive > usage summary 优先级；
  - 低优先级 link 标记 superseded，不删除 ingest audit；
  - 验收：双通道同 session 在 UI 只展示一次，选择结果稳定。

- [ ] T306 completeness engine
  - 计算 expected/linked native executions、expected/observed iterations、checkpoint、
    missing categories 和 fidelity；
  - run 活跃为 collecting，终态缺失为 partial，未知 schema 为 unsupported；
  - 验收：Phase 1 AC-005/008/009 的 golden completeness 全部通过。

### Wave 4：查询与 UI

- [ ] T401 Goal Plus query service/API
  - 实现 source/goal 列表、Goal 详情、run composite trace 和 relink；
  - 所有查询验证 user + source，拒绝只凭 run ID 越权；
  - 避免 N+1 查询，candidate/iteration 批量加载；
  - 验收：两个用户、两个 source 使用相同 run ID 时严格隔离。

- [ ] T402 Goal Plus 列表与详情框架
  - 使用共享 AppTopBar、table/card/dialog 和 design tokens；
  - 展示 Goal status/phase/revision/source/completeness；
  - 不创建 Goal Plus 专属颜色变量。

- [ ] T403 Work DAG 与 candidate lanes
  - Goal Mode 展示 work item depends-on 和 native Execution link；
  - Search Mode 展示 candidate lane、iteration、score、disposition、best/selected；
  - 并行 lane 在窄屏降级为可横向滚动或逐 lane 切换。

- [ ] T404 Native trace 下钻
  - 复用现有 Trace 详情/interaction 组件，不复制 Codex/Pi 渲染器；
  - 清晰标注 native framework、collector mode 和 timing fidelity；
  - Goal Plus semantic nodes 不计入 Tool/LLM/token 指标。

- [ ] T405 Decision/Data Quality 面板
  - 展示 invalidation/successor、selection、promotion/report metadata；
  - 展示 pending/ambiguous/missing sessions、checkpoint 和 fidelity；
  - 提供 self-check/relink 指引，不在 UI 中暴露本地绝对路径。

### Wave 5：分发、文档和真实验收

- [ ] T501 setup/distribution
  - 新增 Goal Plus collector bundle 和 setup route；
  - 安装器校验 bundle SHA-256、Node version 和目标路径；
  - API key 不进入 asset URL 或日志；
  - uninstall 只删除 managed collector 和可选 spool，不删除 `.gp`。

- [ ] T502 安装指导
  - 在安装指导中提供 Goal Plus 的 Pi、Codex、Pi + Codex 宿主 profile；
  - 服务端展开并去重 native collector 依赖，旧 `frameworks=goal-plus` 保持兼容；
  - 明确 profile 只选择已有 Goal Plus 的 Trace 来源，不安装或修改 Goal Plus 本体；
  - 说明先安装 Codex/Pi collector，`.gp` attach 只用于可选语义增强；
  - 说明 remote server 场景必须在 Goal Plus 所在机器运行 local collector；
  - 说明 bounded/metadata-only、历史 scan、detach 和 self-check。

- [ ] T502A native collector 零回归保护
  - 组合安装只复用既有 Pi/Codex 子安装器，不修改 collector core、adapter 或 Execution ID；
  - Goal Plus semantic collector 安装、scan、watch 独立报告状态，失败不回滚或降级 native Trace；
  - 所需 native collector 失败时报告 `NOT READY`，全部成功时 native Trace 报告 `READY`；
  - direct Pi、direct Codex、legacy Goal Plus 的生成脚本行为由 golden tests 固定；
  - profile 依赖重复选择时每个组件只安装一次。

- [ ] T502B Goal Plus watcher 生命周期
  - Goal Plus collector 独立提供 `start`、`stop`、`status`；
  - PID、日志和锁只落在 Goal Plus managed directory，不接管 native watcher；
  - 无 source 时不得显示 ready，重复 start 必须幂等；
  - 安装命令执行目录存在 `.gp` 时允许显式 attach/scan，禁止猜测其他工作区路径。

- [ ] T503 用户与开发者文档
  - 更新 `docs/user-guide/observability/`；
  - 更新 developer guide 的架构、模块、API/contract、数据流和扩展说明；
  - 按 developer guide 的 provenance 规则更新 source commit；
  - 明确 Goal Plus 零写入、Pi passive timing 和 private CoT 边界。

- [ ] T504 真实 Codex 验收
  - 运行一个 Goal Mode work DAG；
  - 运行 2 candidate × 2 iteration Search；
  - 验证 main/work item/candidate/final checker 关联、selection/promotion 和完整性；
  - 对照 `.gp` 和 native Execution 逐项核验。

- [ ] T505 真实 Pi 验收
  - 保持 Goal Plus 原有 `--no-extensions`；
  - 运行同等 Search 和至少一次 same-session continuation；
  - 验证主对话、全部 worker、message/thinking/LLM/tool/usage、snapshot-replace 和
    derived timing 标记；
  - 对照 native JSONL 验证超过 2000 字符及超过默认 batch byte target 的正文无截断；
  - 删除一个复制 fixture 中的 session file，验证 partial/missing category。

- [ ] T506 故障与安全验收
  - 断网、500、429、重启、半写、truncate、unknown schema、oversize；
  - symlink、path traversal、同 ID 跨 user/source；
  - secret、绝对路径、hidden answer 和 private grader payload；
  - 验收：无数据泄露、无 `.gp` 写入、无错误自动关联。

## 4. 测试矩阵

| 测试层 | 覆盖 |
|-|-|
| 纯函数 | Goal Plus parser、Pi native parser、ID/hash、redaction、fidelity |
| Collector | attach/detach、watch/scan、半写、checkpoint、spool、retry |
| API | auth、schema、limits、idempotency、乱序、跨用户隔离 |
| Persistence | migration、upsert、pending parent、snapshot-replace、索引 |
| Correlation | 所有 link method、优先级、ambiguous、superseded |
| Completeness | collecting/complete/partial/unsupported 和 missing categories |
| Adapter 回归 | Codex、Pi、generic、Skill/SubAgent、非 Goal Plus Trace |
| 安装 profile | direct Pi/Codex 行为不变、legacy Goal Plus、Pi/Codex/both 依赖展开和去重 |
| UI | Goal/work DAG/candidate lanes/native drawer/data quality |
| E2E | 真实 Codex、真实 Pi continuation、断网重放、历史 scan |
| Security | symlink/path traversal/secret/absolute path/hidden-answer |

## 5. 必跑检查

每个实现 wave 至少运行最接近模块的测试。最终交付运行：

```bash
npm run test
npx tsc --noEmit
git diff --check
```

新增 Prisma migration 时还要在空数据库和已有测试数据库分别验证迁移。安装 bundle
需要运行 Linux/macOS 与 Windows 分发测试。

浏览器验证遵守仓库规则：完成代码和自动化测试后先询问用户，获得确认后使用
`bash scripts/develop_start.sh` 启动 dev server，执行一个 golden path 和至少一个
partial/unsupported 边界场景。

## 6. 提交建议

按 wave 拆分，避免把外部 parser、schema、UI 和分发塞入一个 commit：

```text
test(goal-plus): add sanitized runtime and pi session fixtures
feat(goal-plus): add read-only semantic collector and durable spool
feat(pi-agent): import goal-plus native sessions passively
feat(goal-plus): persist semantic snapshots and execution links
feat(goal-plus): add composite trace queries and completeness
feat(goal-plus): add observability pages and candidate lanes
docs(goal-plus): add setup, architecture and troubleshooting guides
```

## 7. 退出标准

功能只有同时满足以下条件才算完成：

- Phase 1 AC-001 至 AC-012 全部通过；
- Goal Plus 仓库无必需代码改动；
- Goal Plus `.gp` 在所有测试中保持只读；
- 真实 Codex 和 Pi 场景均有证据，Pi 保持 `--no-extensions`；
- native Execution 没有重复，现有 Codex/Pi 非 Goal Plus Trace 无回归；
- completeness 可以准确暴露缺失，不把 summary-only 数据标为完整；
- 文档、安装、卸载、自检和隐私说明全部可用；
- `npm run test`、类型检查和 `git diff --check` 通过；
- 浏览器验收若未获用户授权，交付说明必须明确标记未执行。
