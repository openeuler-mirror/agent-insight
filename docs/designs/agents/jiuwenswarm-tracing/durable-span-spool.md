---
topic: jiuwenswarm-tracing
title: jiuwen trace 摄取的持久化方案 —— 让大 trace + 重启不再丢数据
status: proposal
created: 2026-06-25
related_code:
  - src/lib/ingest/otel/jiuwen/ingest.ts          # 内存 spool（要替换的对象）
  - src/lib/ingest/claude-otel/spool.ts            # 可复用的磁盘 JSONL spool
  - src/lib/ingest/otel-consumer/consumer.ts       # 可复用的后台再聚合消费者
  - src/lib/ingest/otel-consumer/sources.ts        # 注册 source 的入口
  - src/lib/storage/data-service.ts                # snapshot-replace 落库（要加护栏）
related_design:
  - ../../../design/otel-spool-consumer/            # spool 消费者整体架构
---

# jiuwen trace 摄取的持久化方案 —— 让大 trace + 重启不再丢数据

> **一句话**：jiuwen 是四个框架里唯一「内存 spool + 整条覆盖」双重裸奔的摄取路径——大 trace 撑爆内存触发重启，重启又把内存里攒了一半的 span 全丢，残缺的下一批再用 `snapshot-replace` 把库里仅有的记录覆盖没。修法是把 jiuwen 的 span spool 从内存 Map 换成 claude-otel 那条已经存在、已经验证的**磁盘 JSONL spool + 后台再聚合消费者**，并给 `snapshot-replace` 加一道「不许用更小的快照盖更大的记录」护栏。

---

## 导读（工程师先看这段）

**这是什么** —— 一份针对「jiuwen trace 数据在内存里、重启即永久丢失」这个真实事故的修复方案。不改 jiuwen 业务代码，只动 agent-insight 摄取侧。

**为什么现在做** —— 已发生过一次真实丢数据：一条多 step 的 jiuwen team trace，step1–4 的 span 只攒在内存里、从未落盘；服务因内存阈值重启，内存 spool 连同 step1–4 一起没了；之后到达的残缺批次又用 `snapshot-replace` 把库里那条记录整条覆盖——无版本、无备份。底层对话产物虽然还躺在 `~/.jiuwenswarm/...`，但那是 jiuwen 的私有格式，没有回流通道，agent-insight 里**回不来了**。

**核心判断** —— 这不是一个 bug，是**两个独立缺陷叠加**：
1. **没有持久化 spool**（抗不了重启）——claude / hermes / opencode 都有，只有 jiuwen 没有。
2. **整条覆盖式落库**（残缺会盖掉完整）——只有 jiuwen 用 `snapshot-replace`，其它都是 `monotonic` 合并。
3. 还有一个**触发器**容易被忽略：内存 Map 无界增长，大 trace 本身就是「撑爆内存→重启」的起因。所以光「抗重启」不够，得让 span 根本不常驻堆内存。

**不重新造轮子** —— 修复所需的两块拼图，仓库里都已经有、且已在 claude-otel / hermes 两条路上线验证过：
- 磁盘 JSONL spool：[`claude-otel/spool.ts`](../../../../src/lib/ingest/claude-otel/spool.ts) 的 `appendJsonlBySession` / `readNewLinesSince`。
- 后台再聚合消费者：[`otel-consumer/consumer.ts`](../../../../src/lib/ingest/otel-consumer/consumer.ts)，已有 checkpoint、双 debounce、park、retention。

jiuwen 这条路当初就是原型态留下的技术债——代码注释自己写了修法（[`ingest.ts:18-19`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts)）：

> *Prototype note: the spool is in-memory (per dev process). Productionizing would move it to the same durable spool the claude-otel path uses.*

本文把那句注释展开成可落地的设计。

---

## 1. 事故复盘与根因

### 1.1 发生了什么

```
exporter 批量推送 step1..4 的 span ──► /api/ingest/otel/v1/traces
                                          │
                                  ingestJiuwenOtlp()
                                          │
                            spool: Map<traceKey, Map<spanId, span>>   ← 只在内存
                                          │
                       内存涨到阈值 → 服务重启（server.log）
                                          │
                              内存 Map 清零，step1..4 全没
                                          │
   后续到达的残缺批次 → 重新聚合（只剩部分 span）→ saveExecutionRecord
                                          │
                snapshot-replace：用残缺 incoming 整条覆盖库里记录
                                          │
                                    ✗ 数据永久丢失
```

### 1.2 为什么三条找回路全断

| 找回路径 | 为什么断 | 证据 |
|---|---|---|
| 落盘重读 | jiuwen 摄取从不写盘，只 `spool.set()` 进内存 Map | [`ingest.ts:24,59-61`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts)；`~/.agent-insight/otel_data/` 下只有 `claude/ opencode/ traces/`，无 `jiuwen/` |
| 库里残留旧版 | `snapshot-replace` 跳过 monotonic 合并，直接整条覆盖，无版本无备份 | [`data-service.ts:2023-2034`](../../../../src/lib/storage/data-service.ts) + [`jiuwen.ts:26`](../../../../src/lib/ingest/adapters/jiuwen.ts) |
| 源端重发 | OTLP `BatchSpanProcessor` 每个 span 结束时只发一次，jiuwen 不会重发已结束的 step1–4 | OTLP 导出语义 |

底层原始数据大概率还在 jiuwen 侧（`~/.jiuwenswarm/agent/sessions/...`、`~/.jiuwenswarm/.agent_teams/...`），但格式私有、无自动回流，只能手工重建导入——不作为常规链路。

### 1.3 为什么只有 jiuwen 会丢：两道护栏，jiuwen 两道都没有

| 框架 | 持久化 spool（抗重启） | 落库策略 | 风险 |
|---|---|---|---|
| claudecode | ✅ `otel_data/claude/<day>/sessions/<sid>/logs.jsonl`（`appendFileSync`） | monotonic 合并 | 无 |
| hermes / 通用 OTLP | ✅ `otel_data/traces/`（`appendOtelTraceEvents` 落盘） | monotonic 合并 | 无 |
| opencode | ✅ `otel_data/opencode/` + opencode 自身 durable session 文件 | monotonic 合并 | 无（最稳） |
| **jiuwen** | ❌ 仅内存 Map | ❌ snapshot-replace（整条覆盖） | **会丢** |

- **持久化 spool**：claude/hermes/opencode 在聚合前先把 span 落盘 JSONL，重启后从磁盘重读 → 抗重启。jiuwen 没有。
- **monotonic 合并**：默认策略（[`data-service.ts:2023`](../../../../src/lib/storage/data-service.ts) `|| 'monotonic'`），新批次即便残缺也会和库里已有记录合并，不会盖没完整版。只有 jiuwen 显式设了 `snapshot-replace`。

> **注意**：`snapshot-replace` 本身没错。jiuwen 的设计是「每批都重新聚合全量 span」（[`ingest.ts:5-7`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts)），如果再叠 monotonic 合并会把 turn 重复计两遍——在「全量重聚合」的前提下，覆盖是对的。**问题不在覆盖，在于「全量」只存在内存里**。让「全量」落盘，覆盖出来的就仍是完整 trace。

---

## 2. 设计目标与非目标

**目标**
- G1 **抗重启**：进程重启后能把重启前收到的 span 完整重聚合，库里记录不退化。
- G2 **抗大 trace**：单条大 trace 不再常驻堆内存，从源头消除「数据过大→OOM 重启」的触发器。
- G3 **防覆盖**：任何情况下，残缺/更小的快照都不许覆盖库里更完整的记录（防御纵深）。
- G4 **零改 jiuwen 业务代码**：只动 agent-insight 摄取侧；不要求 jiuwen 重发或改 exporter。
- G5 **复用现有架构**：与 claude-otel 共用 spool / consumer / checkpoint / retention，不另起一套。

**非目标**
- 不做跨机分布式存储 / 多副本（单进程定位，与 otel-spool-consumer 现状一致）。
- 不改 jiuwen 的聚合语义（agent 树重建、token 归位等保持 [`aggregate.ts`](../../../../src/lib/ingest/otel/jiuwen/aggregate.ts) 现状）。
- 不负责把 `~/.jiuwenswarm/...` 的历史产物回流（一次性手工迁移，另议）。

---

## 3. 方案空间（不止落盘到本地）

按「是否动持久层、改动面、抗重启/抗大 trace 能力」排开，给四个真实可选项，外加一道横切的覆盖护栏（任何方案都该叠）。

### 方案 A —— 磁盘 JSONL spool + 后台再聚合消费者（**推荐**）

把 jiuwen 的内存 Map 换成 claude-otel 那条 JSONL 磁盘 spool，并把 jiuwen 注册成 `otel-consumer` 的一个新 source，由后台 loop 再聚合落库。

- **抗重启**：✅ span 落盘，consumer 重启后从 checkpoint 续读、重聚合。
- **抗大 trace**：✅ span 不常驻堆，只在再聚合那一刻按 trace/session 读回来。
- **改动面**：中。复用 spool/consumer/checkpoint/retention，新增「jiuwen span 行的写盘」+「一个 jiuwen source 的再聚合适配」。
- **关键难点**：jiuwen 按 `traceId` 分桶并对 team/fan-out 按 `session.id` 跨 trace 缝合（[`ingest.ts:26-114`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts)），而现有 consumer 是按 `event.sessionId` 分组的——再聚合 source 需要把这套缝合逻辑搬到「从磁盘读回 span 后」执行（详见 §4.3）。
- **与现有架构契合度**：最高，正是注释里写的修法。

### 方案 B —— 原始 OTLP 请求体 WAL（最小改动的兜底）

在 `ingestJiuwenOtlp` 之前/之后，把**解码后的整个 OTLP body**按天/按 trace 追加进一个 write-ahead-log 文件；重启时把 WAL 全量回放一遍 `ingestJiuwenOtlp` 重建内存 Map，再继续。

- **抗重启**：✅（靠回放）。**抗大 trace**：⚠️ 部分——回放后内存 Map 仍会重新涨起来，没解决 G2 的内存常驻。
- **改动面**：最小（几乎不碰聚合逻辑），适合做**临时止血**或 A 的过渡垫片。
- **代价**：WAL 存的是原始 body（含重复 span、未压缩），盘占用比 A 大；回放是「全量重跑」，启动慢；内存峰值问题没根治。

### 方案 C —— 外部持久存储替代内存 Map（SQLite / Redis）

把 `Map<traceKey, Map<spanId, span>>` 换成进程外的 KV / 表（如本地 SQLite 一张 `jiuwen_span_stage` 表，主键 `(traceKey, spanId)`，天然去重）。

- **抗重启**：✅。**抗大 trace**：✅（不在堆里）。
- **改动面**：中大，引入新依赖/新表、新的读写路径，且与 claude-otel 那套**不同构**——等于在仓库里养第二套 spool 机制，违背 G5。
- **结论**：技术上可行，但「复用现有 JSONL spool」比「引第二套存储」更省、更一致，故不优先。除非未来要做多进程/水平扩展，才值得上 C。

### 方案 D —— 源端可靠重发（不可行，记录在案）

让 jiuwen exporter 在收到失败/不确认时重发 step 级 span。`BatchSpanProcessor` 语义是「结束即发一次」，要做到可靠重发需改 agent-core 的 observability——违背 G4（零改 jiuwen），且我们也控制不了上游节奏。**排除**，仅作为「为什么不能指望源端补」的备注。

### 横切护栏 —— snapshot-replace 防退化（**任何方案都叠**）

无论 A/B/C，都给 `snapshot-replace` 落库加一道**单调护栏**：当 incoming 快照在关键计量（如 span 数 / interaction 数 / turn 数 / tokens）上**严格小于**库里现有记录时，判定为「退化快照」，拒绝覆盖或降级为合并，并打 warn 日志。这样即便 spool 在某个极端下仍丢了一部分，也不会把库里更完整的版本盖没——把「整条覆盖」从「无条件」收紧成「只许涨不许缩」。详见 §4.4。

### 选型小结

| 维度 | A 磁盘spool+消费者 | B OTLP WAL | C 外部KV | D 源端重发 |
|---|---|---|---|---|
| 抗重启 (G1) | ✅ | ✅ | ✅ | ⚠️ |
| 抗大trace/内存 (G2) | ✅ | ⚠️ | ✅ | ✅ |
| 改动面 | 中 | 小 | 中大 | 改上游 |
| 架构一致 (G5) | ✅最佳 | ✅ | ❌另起一套 | — |
| 零改jiuwen (G4) | ✅ | ✅ | ✅ | ❌ |

**推荐路径：A 为主，加横切护栏；B 可作为 A 落地前的临时止血或回放垫片。**

---

## 4. 推荐方案详细设计（方案 A + 护栏）

### 4.1 总体数据流（对齐 claude-otel）

```
exporter ──► /api/ingest/otel/v1/traces
               │  jiuwenServiceName(body) === 'jiuwenswarm'
               ▼
        【薄壳】collectJiuwenSpans(body) → 把每个 span 作为一行 JSONL 落盘
               │   spool: otel_data/jiuwen/<day>/<bucket>/spans.jsonl
               │   写完立即返回 200（不再在请求里聚合落库）
               ▼
        【后台】otel-consumer tick（已存在）
               │  readNewLinesSince(file, cursor)  → 发现「脏 bucket」
               │  双 debounce（短=快落库供 UI；长/max=空闲后跑评估）
               ▼
        jiuwen source.aggregate(bucketKey)
               │  从磁盘读回该 bucket（及需缝合的兄弟 trace）的全部 span
               │  → aggregateJiuwenOtlpFromSpans(all)  （复用现有聚合）
               ▼
        saveExecutionRecord(record)  + snapshot-replace 防退化护栏
```

请求处理器退化成「收下→写 spool→200」，与 logs/traces 端点现状一致（[`traces/route.ts:43-45`](../../../../src/app/api/ingest/otel/v1/traces/route.ts) 已是这个形态）。

### 4.2 spool 落盘格式

- 目录：`otel_data/jiuwen/<day>/...`，沿用 [`spool.ts`](../../../../src/lib/ingest/claude-otel/spool.ts) 的 `getExistingInsightDir()/otel_data` 根 + 按天分目录 + 处理后 retention 归档（`compactProcessedSpoolFiles`）。
- 每行 = 一个 `JiuwenSpan`（[`aggregate.ts:19-27`](../../../../src/lib/ingest/otel/jiuwen/aggregate.ts) 的形状：`name/traceId/spanId/parentSpanId/attrs/startNs/endNs`）。`collectJiuwenSpans` 已经能把 body 展平成这个结构，直接序列化即可。
- **去重**：spanId 去重不在写盘时做（JSONL 只追加），而在再聚合「读回后」用 `Map<spanId, span>` 去重——和现状 `spool.get(key).set(s.spanId, s)` 的语义一致，迁移成本最低。
- **分桶键（落盘路径段）**：用 `traceId`（单 agent 一条 trace 一桶），与 `traceKeyFor` 现状一致；team/fan-out 的跨 trace 缝合在再聚合阶段按 `session.id` 完成（见 §4.3）。
  - ⚠️ 现有 consumer 的「脏单位」是 `event.sessionId`，jiuwen 的脏单位是 `traceId/bucket`。落盘行里要带一个 consumer 能识别的「分组字段」。两条实现路线：
    - **(i) 复用现有 consumer**：给每行写一个 `sessionId = <bucketKey>` 字段，让 `runOtelSpoolConsumerTick` 的 `event.sessionId` 提取逻辑（[`consumer.ts:256-260`](../../../../src/lib/ingest/otel-consumer/consumer.ts)）天然把同 bucket 的行归到一起；jiuwen source 的 `aggregate(bucketKey)` 再做 trace 缝合。
    - **(ii) jiuwen 专用 consumer 实例**：若缝合逻辑与「按 sessionId 分组」冲突太大，就用 `startOtelSpoolConsumer({ sources:[jiuwenSource] })` 起一个 jiuwen 专属实例，分组键定义为 jiuwen 自己的 bucket。
  - 倾向 (i)：尽量不复制 consumer 的调度/park/checkpoint 代码。

### 4.3 再聚合 source（jiuwen 的难点所在）

新增一个 `SpoolSource`（[`sources.ts:16-22`](../../../../src/lib/ingest/otel-consumer/sources.ts) 的形状），`aggregate(bucketKey)` 做三件事：

1. **读回**：从磁盘读出该 bucket 的全部 span 行，用 `Map<spanId>` 去重，得到 `JiuwenSpan[]`。
2. **缝合**：把 [`ingest.ts:64-93`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts) 现在「在内存里跨 trace 缝合」的逻辑搬过来——
   - 判断本 bucket 是否属于一个多 trace run（team `team.*` / fan-out `tool.task*` / `agent.*.task_iteration.*`，见 `isMultiTraceSpan`）；
   - 若是，按 `agentteam.session.id` 把同 session 的多个 trace 桶一起读回再聚合；若否，单桶独立聚合。
   - 这要求 source 能「按 session 列出兄弟 trace 桶」——落盘时把 `session.id` 也写进行里（或写进桶的 sidecar 索引），再聚合时据此找齐兄弟桶。
3. **聚合 + 孤儿清理**：调 `aggregateJiuwenOtlpFromSpans(all)`（复用），得到 `ExecutionRecord`；保留现有「team/fan-out 落库后删 `jiuwen-<traceId>` 孤儿」的清理（[`ingest.ts:99-110`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts)）。

> 这一步是整个迁移的核心工作量：**聚合本身不动**，动的是「span 从哪来」——从内存 Map 改成从磁盘读回。缝合/孤儿清理逻辑原样平移。

### 4.4 snapshot-replace 防退化护栏

在 [`data-service.ts`](../../../../src/lib/storage/data-service.ts) 走 `snapshot-replace` 分支（`mergeStrategy === 'snapshot-replace'`，即跳过 monotonic 那段的 else 情形）时，新增比较：

- 取库里现有记录的计量基线（优先 interaction 数 / turn 数；辅以 `tokens`、`llm_call_count`、`tool_call_count`）。
- 若 incoming 在这些维度上**严格小于**现有记录 → 判为退化快照：
  - 默认行为：**拒绝覆盖**，保留旧记录，打 `warn`（含 task_id、新旧计量），并可计数到指标。
  - 可选环境开关（如 `AGENT_INSIGHT_JIUWEN_ALLOW_SHRINK=true`）在确有「正当缩小」场景时放行。
- 相等或增长 → 正常覆盖（保持现状语义）。

这道护栏独立于 spool，是最后一道防线：即便 spool 在某极端下仍残缺，也不会把库里更完整版本盖没。**它把「snapshot-replace=无条件整条覆盖」收紧为「单调不减的快照覆盖」**。

### 4.5 重启恢复时序

1. 进程起来 → `instrumentation-node.ts` 拉起 `startOtelSpoolConsumer()`（[现状 141-142 行](../../../../src/instrumentation-node.ts)）。
2. `seedOnStart` + checkpoint：consumer 读 `consumer-checkpoint.json` 续读游标；**但 jiuwen 要的是「重启后把已落盘但未聚合的 bucket 重新聚合一遍」**——这里要确认 seed 行为：默认 `seedToEof` 会把游标推到 EOF（避免重复处理），对 jiuwen 我们需要的是「重启后对未确认聚合的 bucket 至少再聚合一次」。因为 `snapshot-replace` 幂等（同一份 span 聚合出同一条记录），**让 jiuwen source 在重启后对磁盘上所有 bucket 各跑一次再聚合是安全且自愈的**——重复聚合不会污染（覆盖成相同结果），缺失才会丢。
3. 由 §4.4 护栏兜底：重聚合即便先落了个偏小的快照，后续更全的也能盖回去；而偏小的不会盖掉已有更全的。

> **落地校验点**：`seedToEof` 对 jiuwen 的语义要专门测——确保「重启前落盘、未聚合」的 bucket 在重启后会被再聚合，而不是被 seed 跳过。必要时给 jiuwen source 关掉 seed 或改成「重启后强制全量重聚合一轮」。

---

## 5. 落地步骤（建议顺序）

1. **止血（可选，方案 B 垫片）**：在 `ingestJiuwenOtlp` 入口把原始 body 追加进 `otel_data/jiuwen/wal/<day>.jsonl`，重启时回放。半天工作量，先把「永久丢」降级成「可回放」。
2. **加护栏（§4.4）**：snapshot-replace 防退化。独立、低风险、立即收益，可先于 A 合入。
3. **落盘 spool（§4.2）**：`ingestJiuwenOtlp` 改为「`collectJiuwenSpans` → 写 JSONL → 200」，内存 Map 退役。
4. **jiuwen source（§4.3）**：实现 `aggregate(bucketKey)`（读回+缝合+孤儿清理），注册进 `listSources()`。
5. **重启恢复校验（§4.5）**：确认 seed/checkpoint 对 jiuwen bucket 的语义，补「未聚合 bucket 重启后必被再聚合」测试。
6. **retention**：确认 `compactProcessedSpoolFiles` 覆盖 `otel_data/jiuwen/`，避免 spool 自身无界增长。

第 1、2 步先上线就能堵住「永久丢失」这个最痛的点；3–5 步是根治。

---

## 6. 验证清单

- **单元**：`aggregateJiuwenOtlpFromSpans` 对「从磁盘读回的 span」与「内存 Map 的 span」产出一致（聚合不变性）。
- **重启注入**：灌入 step1–4 → 杀进程（模拟内存重启）→ 重启 → 灌 step5–6 → 断言库里记录含 step1–6（而非只剩 5–6）。这是事故的直接回归测试。
- **退化护栏**：先落一条 6-step 记录，再灌一条只含 2 step 的残缺快照 → 断言库里仍是 6-step，且打了 warn。
- **缝合不回归**：team / fan-out 多 trace run 经磁盘往返后，仍正确按 session 缝合、孤儿 `jiuwen-<traceId>` 被清理（覆盖 [`ingest.ts:99-110`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts) 现有行为）。
- **内存**：灌一条大 trace，观察堆内存不再随 span 数线性常驻（G2）。
- **retention**：处理后的 jiuwen spool 文件按 `AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS` 被归档。

---

## 7. 风险与边界

- **seed/checkpoint 语义差异**（§4.5）：jiuwen 的「脏单位」与 consumer 的 `sessionId` 分组不完全对齐，是本方案最需要小心验证的接缝；最坏情况退到「jiuwen 专属 consumer 实例」（§4.2 路线 ii）。
- **盘占用**：JSONL spool 比内存占盘，但有 retention 归档兜底；相比 B（存原始 body）已经省很多（A 存展平后的 span、读回去重）。
- **聚合频率**：再聚合从「每批同步」变成「后台 debounce」，UI 可见性有秒级延迟（短 debounce ~3s），与 claude-otel 现状一致，可接受。
- **历史数据**：本方案只保未来不丢；`~/.jiuwenswarm/...` 里的历史产物回流是独立的一次性迁移，不在此设计内。
- **不解决跨机**：单进程定位；多副本/水平扩展需要方案 C 或外部存储，届时再议。

---

## 附：关键代码锚点

| 关注点 | 位置 |
|---|---|
| jiuwen 内存 spool（要替换） | [`ingest.ts:24,48-114`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts) |
| 「productionize 即换 durable spool」注释 | [`ingest.ts:18-19`](../../../../src/lib/ingest/otel/jiuwen/ingest.ts) |
| 可复用磁盘 JSONL spool | [`claude-otel/spool.ts`](../../../../src/lib/ingest/claude-otel/spool.ts)（`appendJsonlBySession` / `readNewLinesSince`） |
| 可复用后台消费者 | [`otel-consumer/consumer.ts`](../../../../src/lib/ingest/otel-consumer/consumer.ts) |
| source 注册入口 | [`otel-consumer/sources.ts:28-45`](../../../../src/lib/ingest/otel-consumer/sources.ts) |
| 消费者启动钩子 | [`instrumentation-node.ts:141-142`](../../../../src/instrumentation-node.ts) |
| span 展平 / JiuwenSpan 形状 | [`aggregate.ts:19-62`](../../../../src/lib/ingest/otel/jiuwen/aggregate.ts) |
| snapshot-replace 落库（要加护栏） | [`data-service.ts:2023-2034`](../../../../src/lib/storage/data-service.ts) |
| jiuwen 用 snapshot-replace 的原因 | [`adapters/jiuwen.ts:12-26`](../../../../src/lib/ingest/adapters/jiuwen.ts) |
</content>
</invoke>
