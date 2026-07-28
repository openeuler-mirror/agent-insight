# Trace 上报积压修复方案 — 读路径全量扫描 + 限流闸放大

版本：v0.2
最后更新：2026-07-28
状态：**已实现并端到端压测验证**（分支 `claude/otel-backlog-e2e-fix`，验证结果见 §4.2）

> 文档类型：修复方案（干活清单）｜ 关联 [incident-2026-07-28](incident-2026-07-28-langfuse-trace-gap.md) / [Phase2](phase2-requirements-design.md) / [Phase3](phase3-development-plan.md)
> base_commit：`b960f56`（master）｜ 类型：性能缺陷修复 ｜ 工作量：Medium（约 2～3 人日 + 压测）

---

## 导读（先看这 5 行）

1. **真瓶颈是读路径，不是调度**：`1aac8d3` 只把 spool 的**写**改成了按 session 分片，**读**还是全量扫描整个 spool 目录 —— 聚合 1 条 trace = 扫一遍全部历史数据。
2. **CPU 修复把"烧 CPU"换成了"堵管道"**：`af6fa7f` 的全局冷却 = `上轮耗时 × 3`（封顶 300s）。上轮 51s → **全部 session 冻结 153s**，全局吞吐掉到 ≈ 0.3 条/分钟。
3. 两头必须一起动：只调闸门系数是拆东墙补西墙，只修读路径则成本一旦回升会复发。
4. 本方案分 4 层 + 1 个附带项，**每层都有实测数字**（§4）和**独立开关**（§8），可分批灰度。
5. 本地对拍已验证：定向读与全量读在"纯 shard / 纯 legacy / 跨边界"三类 session 上**逐 spanId 完全一致**，单条聚合读 **72～81ms → 1.4ms（约 50～59×）**。

---

## 1. 因果链复盘

### 1.1 真瓶颈：读路径按"全量"扫，写路径按"session"分片

写路径（`1aac8d3` 之后）：

```
src/lib/ingest/claude-otel/spool.ts:52   sessionSpoolFile()
  → <spoolDir>/<YYYY-MM-DD>/sessions/<safeSegment>/{logs,traces}.jsonl
```

读路径（**没跟着改**）：

```
spool.ts:180  readOtelTraceEventsForSession(sessionId)
  → spool.ts:125 listOtelTraceSpoolFiles()   ← 列出【所有天 × 所有 session】的 jsonl
  → spool.ts:129 readJsonlEventsForSession() ← 每个文件从 0 字节整读，逐行 JSON.parse 后按 sessionId 过滤
```

于是单条聚合的复杂度 = **O(spool 目录总字节数)**，与这条 trace 自己有几个 span 完全无关 —— 这正解释了同事观测到的"只有 2 个 event 的纯 Langfuse trace 依然固定耗时 1.6s"。

三个聚合器全部走这条路径，所以 Claude / CodeAgent / 通用 OTel（Hermes、Langfuse）**都受影响**：

| 聚合器 | 入口 |
|---|---|
| `claude-otel/aggregator.ts:739` | `readClaudeOtelEventsForSession` |
| `codeagent-otel/aggregator.ts:450` | `readCodeAgentOtelEventsForSession` → 同上 |
| `otel/aggregate.ts:25` | `readOtelTraceEventsForSession` |

本地复现（800 session × 20 event + 2 万行 legacy 整日文件 = 34.1MB）：单 session 读取 **73ms**，扫描吞吐 ≈ 468 MB/s。线性外推到线上 7.37GB ≈ **15.8s/条**（容器 overlayfs + 4479 次文件打开更慢，与线上实测 51s 同量级）。

### 1.2 三重闸把单点成本放大成全局冻结

`consumer.ts:254 aggregateCooldownRemaining()` 的冷却是**上一轮耗时的倍数**：

```ts
sessionCooldown = min(300s, lastSessionCostMs × 10)   // 抑制同一活跃 session 重复重聚合 —— 目标正确
globalCooldown  = min(300s, lastGlobalCostMs  × 3)    // 跨 session 全局闸 —— 问题在这
+ aggInFlight → 全局串行（一次只允许一轮聚合）
```

`globalCooldown` 是**跨会话**的：任意一轮慢聚合结束后，**所有** session 都必须等。代入实测成本：

| 单轮聚合耗时 | 本会话冷却 ×10 | 全局冷却 ×3（冻结所有 session） | 全局吞吐上限 | 对照 |
|---|---:|---:|---:|---|
| 51s（master 全量扫描） | 300s（封顶） | **153s** | **≈ 0.3 条/分钟** | 本方案要修的现状 |
| 1.6s（同事已做定向读） | 16s | 4.8s | ≈ 9.4 条/分钟 | 同事实测 25 条/分钟（他们已去掉全局闸） |
| 50ms（目标） | 0.5s | 0.15s | ≈ 300 条/分钟 | 本方案目标 |

**这就是"CPU 修复引发积压"的确切机制**：闸门系数乘在一个病态成本上，把 CPU 满载换成了流水线冻结。注意封顶 300s 也救不了 —— 它只保证"最多冻结 5 分钟"。

附带问题：`consumer.ts:290/332` 在 `aggInFlight` 时按 `max(cooldown, 50ms)` 重排 timer。backlog 里有上千个就绪 session 时，就是**每 50ms 一轮 O(N) 空转唤醒**，且先到先得、无公平性 —— 新来的 live trace 要和 1700 条历史一起抢。

### 1.3 附带发现（不在同事文档里）

| # | 问题 | 代码位置 | 实测 |
|---|---|---|---|
| A | tick 每秒全量递归列目录 + 对每个文件 `stat`+`open`+`close`（**即使没有新数据也 open**） | `consumer.ts:380-391`、`spool.ts:199` | 801 文件 → 23.8ms/tick（dentry 缓存命中；冷启首次 61.8ms）；外推线上 4479 文件 ≈ **130ms/tick ≈ 13% 单核常态空转**，容器 overlayfs 更高 |
| B | `stat` 后提前返回即可省掉无谓 open | `spool.ts:206` | 空读 12.0ms → **1.4ms（8.6×）** |
| C | `state.sessions` 只增不删，进程生命周期内无界增长 | `consumer.ts:162 getSession` | 单条目小，但第 ④ 层要缓存聚合结果，必须先修回收 |
| D | `compactProcessedSpoolFiles` 归档 7 天前的分片；跨 7 天的长 session 再聚合时会读不到早期 span | `retention.ts:33-59` | 既有风险，低频，本次仅记录不修 |

---

## 2. 修复方案总览

```
①  读路径按 session 定向          ← 干掉 O(全量字节)，20～60× 收益
②  legacy 整日文件 byte-range 索引 ← 干掉 ① 之后残留的固定 ~1.6s
③  限流重构：有绝对上限的占空比闸 + 中央调度  ← 保证 backlog 永远能排空，且成本回升不复发
④  游标签名复用，免 fast/evaluated 重复聚合    ← 同一份数据不聚合两次
⑤（附带）tick 常态开销：分层扫描 + stat 提前返回
```

设计原则（对齐同事 §8 的禁区）：**不删/不重置 checkpoint、不改写原始 spool 文件、不放开 SQLite 写并发、不恢复逐 trace 审计日志。**

---

## 3. 逐层设计

### ① 读路径按 session 定向

**改哪**：`src/lib/ingest/claude-otel/spool.ts`

新增定向列举，**遇到名为 `sessions` 的目录时不 readdir，直接拼目标子目录**（避免在有上千个 session 目录的天里做一次全量 readdir）：

```ts
export function listSessionSpoolFiles(spoolDir: string, fileName: string, sessionId: string) {
  const segment = safeSessionPathSegment(sessionId);
  const shards: string[] = [];
  const legacy: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSafe(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'sessions') {
          const target = path.join(full, segment, fileName);   // ← 只 stat 这一个路径
          if (fs.existsSync(target)) shards.push(target);
        } else {
          walk(full);                                          // 兼容多一层嵌套的部署形态
        }
      } else if (entry.isFile() && entry.name === fileName) {
        legacy.push(full);                                     // 旧格式整日平铺文件
      }
    }
  };
  for (const day of readdirSafe(spoolDir)) if (day.isDirectory()) walk(path.join(spoolDir, day.name));
  return { shards: shards.sort(), legacy: legacy.sort() };
}
```

`readClaudeOtelEventsForSession` / `readOtelTraceEventsForSession` 改为：分片整读（一个分片只含一个 session）+ legacy 走 ②。**分片内仍保留 `event.sessionId === sessionId` 过滤**（`safeSessionPathSegment` 有 sanitize/hash，保底防串）。

**不许做**：不能因为分片存在就跳过 legacy —— 跨 6/17 格式切换边界的长 session 会缺早期 span（同事 §11.4 已明确）。合并后按 `spanId` 去重（`otel/aggregate.ts:5 dedupeKey` 已有）。

### ② legacy 整日文件的 sessionId → byte-range 旁路索引

**改哪**：新增 `src/lib/ingest/claude-otel/legacy-session-index.ts`

旁路文件（**不动原始 spool**）：`<file>.jsonl.session-index-v1.json`

```jsonc
{ "version": 1, "indexedBytes": 7340032, "sessions": { "<sid>": [[offset, length], ...] } }
```

- **只线性扫一次**：`indexedBytes === stat.size` → 直接用。
- **追加只补增量**：`indexedBytes < size` → 从 `indexedBytes` 起扫尾部，合并区间。
- **截断/替换/损坏 → 安全重建**：`indexedBytes > size` 或 JSON 解析失败或 version 不符 → 从 0 重建，不抛错。
- **区间合并带空洞容忍**：相邻区间间隔 ≤ `COALESCE_GAP_BYTES`（64KB）则合并，把索引体积从 O(行数) 压到 O(文件大小/64KB)。实测 2 万行 legacy 文件索引 **307KB**。
- **只索引完整行**：`indexedBytes` 只推进到最后一个换行符，末行不完整下次再补 —— 天然处理多字节 UTF-8 与写入中途。
- **原子落盘**：tmp + rename（与 `checkpoint.ts:51 writeCheckpoint` 同款）。
- **进程内缓存**：按 `(path, size, mtimeMs)` 缓存已解析索引，避免每次聚合重新 parse 300KB JSON。
- **命名约束（重要）**：旁路文件后缀是 `.json` 而非 `.jsonl`，因此不会被 `listJsonlSpoolFiles`（`spool.ts:103`）和 `checkpoint.ts:81 listJsonlFiles` 当成 spool 发现 —— **实现时必须保持这一点**，并补一条断言测试。
- `retention.ts` 归档 legacy 文件时一并删除其旁路索引。
- **可选提速**：建索引时只需要 `sessionId`，用 `/"sessionId"\s*:\s*"([^"]+)"/` 先行提取、匹配失败再回落 `JSON.parse`，可省掉整行反序列化（线上单行可达数十 KB）。**前提**是先补一条测试证明 `attributes` 嵌套里不会出现同名键；拿不准就老实 `JSON.parse`，这一步只跑一次。

### ③ 限流重构

#### ③a 闸门：有绝对上限的占空比 + backlog 排空模式

| 项 | 现状 | 提议 | 理由 |
|---|---|---|---|
| 本会话冷却 | `min(300s, cost×10)` | `min(60s, cost×10)` 保留 | 抑制同一活跃 session 重复重聚合 —— 这才是原 CPU 事故的正确靶子 |
| 全局冷却 | `min(300s, cost×3)` | `min(GLOBAL_MAX_WAIT_MS=2000, cost×3)` | **绝对上限**：无论单轮多慢，全局吞吐不低于 ≈0.5 条/s |
| backlog 排空 | 无 | `backlog ≥ 200` → 全局等待置 0；`< 100` 恢复（滞回） | 有积压时的工作是必要的、非冗余的；节流只是把它推后 |
| 单飞 `aggInFlight` | 有 | **保留** | 单飞已把聚合 CPU 上限锁死在 1 核，SQLite 单写不变 |

排空模式的安全性论证：原事故是 **101% CPU = 恰好一个核**，且烧的是**同一 session 的重复重聚合**。单飞 + 本会话冷却已经消灭了冗余；剩下的是必须做的工作，此时限流只会延长积压。

#### ③b 中央调度队列（取代 per-session timer 争抢）

- `SessionState` 用 `fastDueAt / evaluatedDueAt` 两个**时间戳**取代 3 个 timer。
- 单个 dispatcher：一轮结束后 + 每 tick 计算就绪集合，**live : recovery = 3 : 1** 公平出队（live = `LIVE_WINDOW_MS`=60s 内收到过新数据的 session）。这是同事已压测验证的比例。
- 唤醒次数从"每 50ms × N 个 session"降到 O(1)/次调度，消灭重试风暴。
- **watchdog**：当前 dispatch 超过 `STALL_MS`（15s）输出一次 `stalled dispatch`（sessionId / phase / age / backlog），同一任务每分钟最多一条，日志增量预算 < 2MB/天。

> **最小实现回退**：若不想动调度结构，至少把 `aggInFlight` 的重排改成**单个全局唤醒 timer**（只让一个 session 排 timer，醒来后统一选人），可消掉 O(N) 空转，但拿不到公平性。

### ④ 免重复聚合：游标签名复用

现状 `saveFast`（3s）与 `saveEvaluated`（30s）各做一次**完整聚合**，同一份数据聚合两次。

- 新增轻量 `statSessionSpool(spoolDir, fileName, sessionId)` → `{ signature }`，签名 = 该 session 各分片/区间的 `relPath:size` 拼接（仅 ~3 次 `stat`）。
- `SessionState.lastAggregate = { sourceId, signature, record, eventCount }`。
- `saveEvaluated` 时签名未变 → **复用缓存 record**（只覆盖 `skip_evaluation/force_judgment` 等标志位），跳过 `source.aggregate`；签名已变 → 重新聚合。
- **回收（同时修 §1.3-C）**：evaluated 保存完成后立即丢弃 `lastAggregate`；`pendingFileKeys` 空且无待办 deadline 的 SessionState 整体从 `state.sessions` 移除；再加 `MAX_TRACKED_SESSIONS`（默认 5000）LRU 兜底。

### ⑤ 附带：tick 常态开销

- `readNewLinesSince`（`spool.ts:199`）：`stat.size <= cursor.bytes` 直接返回，**不 open**（实测 8.6×）。
- `listFiles()` 分层：当天目录每 tick 扫，历史目录每 `HISTORY_SCAN_MS`（默认 60s）扫一次并缓存结果。

---

## 4. 实测数据（本地，方案原型对拍）

环境：macOS / SSD / Node 23.10；样本 = 800 session × 20 event + 2 万行 legacy 整日文件 = 34.1MB / 801 文件。
脚本：`bench-spool-read.ts` / `bench-proposed.ts` / `bench-tick.ts`（见 §9 产物）。

**单条聚合的 spool 读取耗时**

| 场景 | 现状（全量扫描） | 提议（定向读 + legacy 索引） | 倍数 | 事件数一致 |
|---|---:|---:|---:|:--:|
| 纯 shard session | 81.0ms | **1.37ms** | 59× | ✅ 20 = 20 |
| 跨 legacy+shard 边界 session | 72.1ms | **1.42ms** | 51× | ✅ 30 = 30 |
| 纯 legacy session | 72.4ms | **1.54ms** | 47× | ✅ 40 = 40 |

一致性判定 = 两种实现返回事件的 **spanId 集合逐一比对**，三类场景全部相等。

**其他**

| 指标 | 现状 | 提议 |
|---|---:|---:|
| legacy 首次建索引（一次性） | — | 51ms / 2 万行 |
| legacy 索引体积 | — | 307KB |
| tick 空转（801 文件） | 23.8ms | ~13ms（stat 提前返回）→ 分层扫描后更低 |
| 单文件空读 | 15µs | 2µs |

### 4.2 端到端压测验证（真实上报 → 真实 UI 数据）

压测形态：自建 Langfuse OTLP 上报器（`test/load/langfuse-reporter.ts`）以 **30 trace/s × 180s** 打真实
`/api/ingest/otel/v1/traces`，每 trace 5 个 span、约 11KB；独立 spool + 独立 SQLite 库 + 独立 HOME，
不碰任何真实数据。上报侧按"应发未发补齐"发送，服务端再慢也不会让输入压力跟着塌下来。
修复前后**参数完全一致、环境每轮重置**。

| 指标 | 修复前 | 修复后 | 变化 |
|---|---:|---:|---|
| 上报 → 入库 | 5400 → **291（5.4%）** | 5400 → **5400（100%）** | 一条不丢 |
| 稳态入库速率 | 38 条/分钟 | **1051 条/分钟** | **27.7×** |
| 可见延迟最大 | 272.8s（且只统计到了那 5.4%） | **95.1s** | — |
| 300s 观察窗内仍不可见 | **5109 条** | **0 条** | — |
| backlog 峰值（pendingFiles） | 5192 | 2503 | — |
| 上报停止后排空 | 0.5 条/s，外推需 **近 3 小时** | **82s 内清空** | — |
| CPU 均值 / 峰值 | 58% / 141% | 65% / 222% | 见下 |

> 修复前的"可见延迟 P50 12.1s"看起来比修复后的 27.9s 还好，是**幸存者偏差**：修复前只有 5.4% 的
> trace 曾经出现过，统计的是那批最早被处理掉的；修复后统计的是全部 5400 条。真正可比的是
> "有多少条最终看得见"和"最大延迟"。
>
> CPU 峰值上升是预期的：修复后单位时间干的**有效工作**多了 27 倍，且排空模式下不再人为闲置。
> 单飞（一次只允许一轮聚合）没有放开，SQLite 仍是单写。

**同一份真实 spool 上的读路径对拍**（82.7MB / 5400 个 session 分片，取 40 个 session）：

| 读法 | P50 | P95 | 取到事件数 |
|---|---:|---:|---:|
| 全量扫（修复前） | 405.3ms | 430.6ms | 200 |
| 定向读 + legacy 索引（修复后） | **0.24ms** | **0.49ms** | 200 |
| | **1705×** | | **完全一致** |

**数据完整性**（修复后 5400 条）：唯一 taskId 5400、span 齐全（llm=2/tool=2）5400、
framework 正确 5400、用户归属正确 5400；上报 traceId 与入库 taskId 差集 **0**。

**回归**：`npx tsc --noEmit` 0 错；全量测试连跑两次均为 699 tests / 689 pass / 9 fail，
其中 9 条失败与原始 commit `b960f56`（690 / 680 / 9）**逐条一致**，都是本 worktree 固有的
experiment 系列测试库不可写；即新增 9 条用例全过、失败数未变。

**外推线上（7.37GB / 4479 文件）**

| | 现状 | 修复后（预期） |
|---|---:|---:|
| `source.aggregate` | ~1600ms（同事实测，含定向读）／master 全量约 51s | **< 100ms** |
| 全局吞吐 | 0.3～25 条/分钟 | **≥ 300 条/分钟** |
| tick 常态空转 | ~130ms/s ≈ 13% 单核 | < 20ms/s |

---

## 5. 落地清单（文件级）

| # | 文件 | 改动 | 层 |
|---|---|---|---|
| T1 | `src/lib/ingest/claude-otel/spool.ts` | 新增 `listSessionSpoolFiles` / `statSessionSpool`；改写 `readClaudeOtelEventsForSession`、`readOtelTraceEventsForSession`；`readNewLinesSince` 加 stat 提前返回 | ①⑤ |
| T2 | `src/lib/ingest/claude-otel/legacy-session-index.ts`（新增） | 索引建立/增量/重建/按 range 读 + 进程内缓存 | ② |
| T3 | `src/lib/ingest/otel-consumer/consumer.ts` | 闸门重构（③a）、中央调度 + 公平出队 + watchdog（③b）、游标签名复用 + SessionState 回收（④） | ③④ |
| T4 | `src/lib/ingest/otel-consumer/sources.ts` | `SpoolSource` 增 `statSession(sessionId)`，供 ④ 取签名 | ④ |
| T5 | `src/lib/ingest/otel-consumer/retention.ts` | 归档 legacy 文件时连带清理 `.session-index-v1.json` | ② |
| T6 | `src/lib/ingest/otel-consumer/consumer.ts` | `listFiles` 分层扫描（当天/历史） | ⑤ |
| T7 | 测试（见 §6） | 新增 3 个测试文件 + 扩充 2 个 | 全部 |
| T8 | `docs/developer-guide/05-data-and-control-flow.md` | 更新读路径与调度描述 | — |

**顺序**：T1 → T2 →（此时可先灰度验证 ①②，收益最大、风险最低）→ T3/T4 → T5/T6 → T7/T8。

### 5.1 实现时对本方案的一处修正

**区间合并阈值从 64KB 改成 4KB**（`COALESCE_GAP_BYTES`）。方案原本按"索引体积"选了 64KB，
写完测试才发现方向错了：legacy 整日文件里几十个会话是**交错**写的，同一会话相邻两行往往隔十几 KB，
64KB 会把所有区间并成一整块 —— 索引建了等于没建，还是全文件扫。测试用例
`legacy 旁路索引：只线性扫一次` 当场把它抓了出来（第二次读了 153KB / 169KB）。
改成 4KB（一个页大小）后既能并起同一会话的连续批次，又不会跨过别的会话。
另加 `MAX_RANGES_PER_SESSION = 4096` 兜底：病态交错的文件不会把索引撑爆，超限就并进最后一个区间
（读多一点，仍然正确）。

---

## 6. 测试计划

### 6.1 正确性回归（必须）

新增 `test/otel-spool-session-read.test.ts`：

1. **对拍**：同一 spool 下，定向读与全量读结果的 spanId 集合相等 —— 覆盖纯 shard / 纯 legacy / 跨边界三类 session。
2. **跨天**：同一 sessionId 在多天各有分片 → 事件全取到，按 `startTimeMs` 有序。
3. **脏 sessionId**：含中文、`/`、超 80 字符（触发 `safeSessionPathSegment` 的 sanitize+hash 分支）→ 定向读能命中。
4. `sessions/unknown/` 分片不会被误归给任何真实 session。
5. 分片存在时**仍会**读 legacy（防止有人"优化"掉 fallback）。

新增 `test/otel-legacy-session-index.test.ts`：

6. 首次建索引后再次调用**不再线性扫**（断言扫描字节数 / `readSync` 调用计数）。
7. 追加后只索引新增字节（扫描字节数 == 新增字节数）。
8. 文件被截断或整体替换（size < indexedBytes）→ 全量重建且结果正确。
9. 索引文件损坏 / version 不符 → 静默重建，不抛错。
10. 多字节 UTF-8（中文 payload）+ 末行不完整 → 不丢事件、offset 不错位；末行补全后下次能读到。
11. 索引旁路文件**不会**出现在 `listOtelTraceSpoolFiles` / `checkpoint.listJsonlFiles` 结果里。
12. 区间合并：间隔 ≤64KB 合并、>64KB 不合并（索引体积可控）。

### 6.2 调度与活性

扩充 `test/otel-consumer.test.ts` + 新增 `test/otel-consumer-scheduling.test.ts`（可直接吸收同事 `otel-consumer-liveness.test.ts` 的 5 个场景）：

13. 20 个不同 traceId → 20 次 `saveExecution`，不被合并。
14. **闸门绝对上限**：把单轮耗时人为拉到 60s → 下一次 dispatch 的等待 ≤ `GLOBAL_MAX_WAIT_MS`，不出现 153s 冻结（**这是本次事故的直接回归用例**）。
15. **排空模式滞回**：backlog 越过 200 → 全局等待归零；回落到 <100 → 恢复占空比闸；在 100～200 区间反复不抖动。
16. **公平性**：1700 条 recovery backlog 存在时，新 live session 在 15s 内进入 save（3:1 出队）。
17. `saveExecution` 永久 pending → 每分钟一条 `stalled dispatch`，不刷屏；tick 仍存活。
18. `saveExecution` reject → park 后其余 session 继续处理。
19. 聚合期间 spool 追加 → checkpoint 不越过未保存的数据（沿用 `test/otel-spool-cursor.test.ts` 断言）。
20. 无 50ms 重试风暴：N 个就绪 session 时，单位时间唤醒次数 O(1) 而非 O(N)。

### 6.3 免重复聚合

21. fast 后无新增字节 → evaluated **不再调用** `source.aggregate`（spy 计数 == 1），但仍触发评估调度。
22. fast 后有新增字节 → evaluated 重新聚合（spy 计数 == 2）。
23. session 完成后 `state.sessions` 条目被回收；超过 `MAX_TRACKED_SESSIONS` 时 LRU 淘汰。

### 6.4 压测脚本（不进 CI）

`scripts/bench-otel-consumer.ts`：造 1700 legacy session + 800 shard session，输出 backlog 排空速率、新 trace P95 入库延迟、CPU 占用曲线、`source.aggregate` P50/P95。修复前后各跑一遍存档。

### 6.5 上线前对拍（预生产）

用**真实 spool 目录的只读副本**跑 §6.1-1 的对拍脚本，逐 session 比对 spanId 集合，**零差异**才允许上线。

---

## 7. 验收标准

| # | 指标 | 目标 | 怎么测 |
|---|---|---|---|
| 1 | `source.aggregate` P95 | **< 100ms**（现状 ~1606ms / master 全量 ~51s） | 生产阶段诊断日志 |
| 2 | backlog 排空速率 | **≥ 300 条/分钟**（现状 0.3～25） | 连续 10 分钟 tick 日志单调趋降 |
| 3 | backlog ≥1700 时新 trace 入库延迟 | **P95 < 15s** | 20 个新 traceId 四段漏斗核验（同事 §7） |
| 4 | 单轮聚合退化到 60s 时的全局等待 | **≤ 2s**（不再冻结） | 测试用例 §6.2-14 |
| 5 | 稳态 CPU | **< 30% 单核**，无持续满载 | `docker stats` + `scripts/diagnose-otel-consumer.sh` |
| 6 | tick 常态空转 | < 20ms/tick | 阶段诊断 |
| 7 | SQLite 写并发 | 保持 **1** | 测试断言最大在途 save == 1 |
| 8 | 跨 legacy/shard 的 session event 数 | **不缩水** | §6.1-1 对拍零差异 |
| 9 | checkpoint | 不删除、不重置、不越过未保存数据 | §6.2-19 |
| 10 | 诊断日志增量 | < 2MB/天 | 日志体积统计 |

---

## 8. 灰度与回滚

每层挂独立 env 开关，**默认开启，可单独一键回退**，不需要回滚镜像：

| 开关 | 默认 | 关掉后的行为 |
|---|---|---|
| `AGENT_INSIGHT_OTEL_SESSION_TARGETED_READ` | `1` | 回到全量扫描读（①失效） |
| `AGENT_INSIGHT_OTEL_LEGACY_INDEX` | `1` | legacy 文件回到全量扫描（②失效，①仍生效） |
| `AGENT_INSIGHT_OTEL_AGG_GLOBAL_MAX_WAIT_MS` | `2000` | 调大即退回旧的"慢聚合冻结"行为 |
| `AGENT_INSIGHT_OTEL_AGG_DRAIN_BACKLOG` | `200` | 设成极大值 = 关闭排空模式 |
| `AGENT_INSIGHT_OTEL_CONSUMER_HISTORY_SCAN_MS` | `60000` | 设成 `1000` = 退回每 tick 全量扫 |
| `AGENT_INSIGHT_OTEL_AGG_REUSE_SNAPSHOT` | `1` | 关掉 ④，evaluated 重新聚合 |

**灰度顺序**：先只开 ①②（收益最大、只读逻辑、风险最低）观察一轮 → 再开 ③ → 最后开 ④⑤。

**回滚安全性**：①②④⑤ 只影响读取与调度，不改变落盘格式，也不改 checkpoint 语义 → 任意时刻关掉开关即恢复旧行为，**无需清 spool、无需重置 checkpoint**。②的旁路索引文件是纯附加物，删掉即可（下次自动重建）。

---

## 9. 风险与未决

| 风险 | 影响 | 缓解 |
|---|---|---|
| legacy 首次建索引要线性扫一遍大文件 | 首条聚合被阻塞（7.37GB 约几十秒） | 放在 consumer 启动时异步预热；预热未完成前该文件走旧的全量读；或运维侧提前跑一次建索引脚本 |
| 索引区间合并的空洞容忍导致多读少量字节 | 读放大 ≤64KB/区间 | 可调 `COALESCE_GAP_BYTES`；已在 §6.1-12 断言 |
| 排空模式下 CPU 跑满单核 | 与旧事故观感相似 | 单飞已锁死 ≤1 核；且此时是必要工作；watchdog + 滞回退出；必要时把排空模式的占空比设为 50% 而非 100% |
| ③b 中央调度是结构性改动 | 引入新的活性缺陷 | 用 §6.2 的 8 条故障注入用例兜底；提供"最小实现回退"路径 |
| §1.3-D：retention 归档跨 7 天长 session 的早期分片 | 长 session 再聚合时 event 缩水 | 既有问题，本次不修；建议单开 issue（归档前检查 session 是否仍活跃） |
| 与同事 `new-dev-7-28` 分支冲突 | `consumer.ts` / `spool.ts` 双改 | 见 §10 |

---

## 10. 与同事 `new-dev-7-28` 分支的关系

| 本方案 | 同事分支状态 | 合并建议 |
|---|---|---|
| ① 定向读 | 已实现（`listSessionJsonlSpoolFiles`） | 等价能力。本方案多了"遇 `sessions` 目录只 stat 目标子目录"的剪枝，避免在上千 session 的天里做全量 readdir —— 建议取本方案的剪枝版 |
| ② legacy 索引 | **未实现**（同事 §11.4 推荐方向） | 直接采用本方案 |
| ③a 闸门绝对上限 + 排空模式 | 未实现（他们直接去掉了跨 session 全局冷却） | 采用本方案：保留占空比保护，但加绝对上限，避免旧 CPU 事故复发 |
| ③b 中央队列 + 3:1 公平 | **已实现并压测** | 采用同事实现，补 §6.2 的用例 |
| ④ 免重复聚合 | 未实现（同事 phase2 待办） | 直接采用本方案 |
| ⑤ tick 常态开销 | 部分（当天/历史分频扫描） | 合并两者：分频扫描（同事）+ stat 提前返回（本方案） |

**结论**：两边不冲突，是互补的。建议以同事分支的 ③b 中央队列为骨架，把本方案的 ①（剪枝版）②③a④⑤ 叠上去。

---

## 附：本方案的验证产物

| 文件 | 作用 |
|---|---|
| `bench-spool-read.ts` | 复现"聚合 1 条 = 扫全量"的成本，输出 MB/s 与线上外推 |
| `bench-proposed.ts` | 定向读 + legacy 索引原型，与现状**逐 spanId 对拍** + 前后耗时对比 |
| `bench-tick.ts` | tick 常态空转开销：现状 vs stat 提前返回 vs listFiles |

> 这三个脚本是**方案验证原型**，未进仓库；实现 T1/T2 时应把其中的对拍逻辑固化成 §6.1-1 的测试用例。
