# Goal Plus 观测接入：需求设计

- 状态：提案
- 关联需求：[Phase 1](phase1-requirements-analysis.md)
- 全流程设计：[流程图与状态流](architecture-flow.md)
- 交互预览：[集成后高保真页面](agent-insight-goal-plus-hifi.html)
- 基线提交：`679630181999`
- 最后更新：2026-09-03

## 1. 设计摘要

Agent Insight 新增一个本地 Goal Plus collector，把 `.gp` durable state 解析成
Goal Plus semantic snapshots；Codex/Pi native trace 仍进入现有 OTLP/Execution
链路。服务端用独立 domain tables 和 link table 组合两类数据。

Pi 是唯一需要新增 native trace 采集方式的宿主。Goal Plus worker 明确关闭全局
extension，但保存了 native Pi session。collector 直接读取 session JSONL，转换为
现有 `pi-agent` canonical events，再通过现有 OTLP endpoint 入库。整个方案不要求
Goal Plus 改动。

核心数据流：

```text
Explicitly attached .gp root
        │
        ├── goal/run/candidate/session snapshots
        │          │
        │          ▼
        │   Goal Plus semantic parser
        │          │ durable semantic spool
        │          ▼
        │   POST /api/ingest/goal-plus/v1/snapshots
        │          │
        │          ▼
        │   Goal Plus domain tables
        │
        ├── Pi native session JSONL
        │          │
        │          ▼
        │   Pi passive importer → canonical events
        │          │ existing OTLP spool/API
        │          ▼
        │   framework=pi-agent Execution
        │
        └── Codex native IDs/task names
                   │ join existing Codex Execution
                   ▼
             GoalPlusExecutionLink
                   │
                   ▼
             Composite Goal Plus Trace
```

## 2. 核心决策

| 编号 | 决策 | 原因与代价 |
|-|-|-|
| D-001 | Goal Plus 是 orchestration overlay，不是 framework | native Execution 必须继续走 Codex/Pi adapter，避免破坏 Skill、token 和 subagent 统计 |
| D-002 | Agent Insight 主动只读 `.gp`，本期不改 Goal Plus | Goal Plus durable state 已包含足够语义和关联 ID；减少跨仓耦合 |
| D-003 | Pi worker 使用 passive native-session importer | `--no-extensions` 是有意隔离；读取既有 session 可无侵入补齐 trace |
| D-004 | semantic 数据使用 snapshot-replace | Goal Plus run/candidate 主要是权威 JSON snapshot，不应伪装成完整 append-only event stream |
| D-005 | native Execution 树保持不变，新增 link table | 一个 Goal 的编排图与宿主调用树不是同一种关系 |
| D-006 | 禁止纯时间窗口自动关联 | 审计关系错误比暂时 unresolved 更严重 |
| D-007 | 完整性与 fidelity 分开计算 | Pi passive import 可以语义完整但时间为 derived |
| D-008 | source ID 由 Agent Insight 管理 | 不向 `.gp` 写 source file，满足完全只读 |
| D-009 | Goal Plus semantic snapshots 走专用 API | OTLP span 不适合表达 revision、selection、promotion 等领域状态 |
| D-010 | 默认 bounded-content，支持 metadata-only | 与现有 trace 价值和隐私策略对齐，同时保护 hidden-answer 数据 |

## 3. 组件设计

### 3.1 本地目录

安装后的建议目录：

```text
~/.agent-insight/
├── collectors/goal-plus/
│   ├── current/
│   │   ├── goal-plus-collector.cjs
│   │   └── lib/
│   ├── config.json
│   └── sources.json
└── otel_data/goal-plus/<api-key-hash>/
    ├── semantic/
    │   ├── pending/
    │   ├── uploading/
    │   ├── rejected/
    │   └── checkpoints.json
    └── pi-native/
        └── <existing trace transport state>
```

`sources.json` 由 Agent Insight 管理，不写入目标 `.gp`。每个 source 包含：

```json
{
  "sourceId": "gpsrc_01J...",
  "root": "/workspace/project/.gp",
  "workspaceFingerprint": "sha256:<digest>",
  "mode": "watch",
  "contentMode": "bounded",
  "enabled": true,
  "createdAt": "2026-09-02T10:00:00Z"
}
```

`root` 只保存在本机配置中。上报时发送 `sourceId`、用户设置的可选 label 和不可逆
workspace fingerprint，不发送绝对路径。

### 3.2 CLI

collector 至少提供：

```text
goal-plus-collector attach --root <workspace/.gp> [--watch]
goal-plus-collector scan --root <workspace/.gp>
goal-plus-collector list
goal-plus-collector self-check --source <source-id>
goal-plus-collector detach --source <source-id>
goal-plus-collector watch
```

- `attach` 校验目录形状后登记 source；
- `scan` 执行一次历史扫描，不长期驻留；
- `watch` 只观察已登记 source；
- `detach` 删除 Agent Insight 本地登记和未发送 checkpoint，不删除 `.gp`；
- `self-check` 显示可读对象数、schema、Pi session 可见性、spool 和最近上传结果。

初始实现可以先支持 foreground `watch`；后台 service 安装属于部署任务，不应通过
未跟踪子进程偷偷常驻。

### 3.3 Source identity

`sourceId` 是 Agent Insight 生成的随机 ULID/UUID。`workspaceFingerprint` 用于提示
用户可能重复 attach，不作为跨 source 合并主键。

规则：

- 同一 `sources.json` 中相同 canonical root 重复 attach 返回原 source；
- `.gp` 移动后由用户 detach/attach，默认生成新 source；
- 用户可以显式 `--reuse-source <id>` 迁移 root，但 self-check 必须验证至少一个已知
  goal/run ID 与历史 source 相符；
- 不能根据工作区路径 hash 直接生成 source ID，因为路径会泄露且移动会改变身份；
- 服务端唯一范围始终是 `(userId, sourceId, object kind, object key)`。

## 4. `.gp` 数据源与解析

### 4.1 允许读取的文件

| Kind | 路径 | 用途 |
|-|-|-|
| `goal` | `goal-plus/*/goal.json` | Goal、revision、phase、work items、active session、linked search |
| `goal_event` | `goal-plus/*/events.jsonl` | Goal 状态审计时间线 |
| `frozen_spec` | `specs/*/frozen_spec.json` | spec hash、metric、strategy、verifier hashes |
| `run` | `runs/*/run.json` | run 状态、best/selected、invalidation/successor |
| `candidate` | `runs/*/candidates/*/candidate.json` | candidate 和 retained iterations |
| `agent_session` | `runs/*/agent_sessions/*.json` | host/native identity、workspace fingerprint、usage metadata |
| `best` | `runs/*/best.json` | best artifact 交叉校验 |
| `report_meta` | `runs/*/report.md`, `report.html`, `promotion/*` | 是否存在、hash、大小、相对路径；默认不上传正文 |
| `pi_session` | agent session metadata 指向的 session file，或 `host-sessions/pi/<id>*` | Pi native trace |

collector 不读取 candidate workspace，不跟随符号链接，不读取 verifier command 指向
的外部文件，也不读取任意 `log_paths` 内容。

### 4.2 文件稳定读取

Goal Plus JSON snapshot 可能采用原子替换，也可能被观察到半写窗口。读取算法：

1. `lstat`，拒绝 symlink 和非普通文件；
2. 校验文件仍位于 source root 内；
3. 读取前后比较 size、mtime 和 inode/file ID；
4. JSON 解析失败或文件变化时进行有界重试；
5. 计算原始字节 SHA-256；
6. 相同 relative path + hash 不重复解析/发送；
7. 删除文件只记录 source diagnostic，不远端级联删除历史审计数据；
8. snapshot 新版本以 `observedAt` 和 payload 中的权威时间更新 current projection。

JSONL 使用完整换行作为提交边界；尾部不完整行留到下一轮。`goal_event` 的稳定 ID
优先使用源事件 ID；无 ID 时使用 source、relative path、line byte offset 和行 hash
生成确定性 ID。

### 4.3 Semantic snapshot envelope

```ts
type GoalPlusSnapshotKind =
  | 'goal'
  | 'goal_event'
  | 'frozen_spec'
  | 'run'
  | 'candidate'
  | 'agent_session'
  | 'best'
  | 'report_meta';

interface GoalPlusSnapshotEnvelopeV1 {
  format: 'agent-insight.goal-plus-snapshot';
  version: 1;
  snapshotId: string;
  sourceId: string;
  kind: GoalPlusSnapshotKind;
  objectKey: string;
  parentKeys: {
    goalId?: string;
    goalRevision?: number;
    specId?: string;
    runId?: string;
    candidateId?: string;
    agentSessionId?: string;
  };
  sourceSchemaVersion?: number;
  contentHash: string;
  observedAt: string;
  payload: Record<string, unknown>;
  redaction: {
    contentMode: 'bounded' | 'metadata-only';
    truncatedFields: string[];
    removedFields: string[];
  };
}
```

`snapshotId` 由 `sourceId + kind + objectKey + contentHash` 计算。服务端按 snapshot ID
幂等，同时按 object key 更新 current projection。

### 4.4 Payload allowlist

#### Goal

允许：ID、status、phase、policy 摘要、revision、revision 时间、triage、work item
状态/依赖/route、linked search IDs、next action 类型、active session host/session ID、
final check 状态和权威时间。

`raw_goal`、work item objective、summary 默认经过现有 secret/path redaction 后截断；
metadata-only 模式只发送 hash 和长度。

#### Frozen spec

允许：spec ID/hash、metric name/direction、strategy、budget 摘要、edit surface 数量、
verifier artifact/hash 列表。禁止发送 hidden gold、verifier command 参数、环境变量和
外部绝对路径。

#### Run/candidate/iteration

允许：状态、candidate/iteration ID、score、pass、disposition、failure class、Git
head、artifact hash、changed file 相对路径、模型、usage、created time、selection、
invalidation 和 successor。禁止上传完整 diff、log 内容和 workspace 绝对路径。

#### Agent session

允许：agent session ID、run/candidate、host、external ID、task name、role、模型、
计数、evidence read generation、Pi session file fingerprint 和 usage。session file 绝对
路径只在本地用于读取。

## 5. Pi native session importer

### 5.1 Session 定位

对 `host=pi-rpc` 的 `AgentSessionRecord`，按以下顺序定位：

1. `host_handle.metadata.pi_metrics.session_file`；
2. `launch.session_dir + host_handle.external_id`；
3. `<source-root>/host-sessions/pi/` 下与 `external_id` 精确匹配的普通文件。

任何 fallback 都必须限制在已登记 root 或显式允许的 session root。出现多个匹配时
标记 unresolved，不按 mtime 选择。

### 5.2 Canonical identity

passive import 的 canonical session ID：

```text
goal-plus:<sourceId>:<agentSessionId>
```

native Pi session ID 保存为 attribute：

```text
goal_plus.source_id
goal_plus.goal_id
goal_plus.run_id
goal_plus.candidate_id
goal_plus.agent_session_id
goal_plus.native_session_id
goal_plus.collector_mode = pi-native-passive
```

同一 native session 的跨进程 continuation 继续更新同一 canonical session，并使用
现有 Pi adapter 的 `snapshot-replace`，不为每次进程启动建立重复 Execution。

### 5.3 Native entry 映射

| Pi native entry | Canonical event |
|-|-|
| user message | agent/input 或 message interaction |
| assistant message | LLM span；提取 model/provider/stop reason/usage/content |
| assistant `toolCall` content | Tool/MCP/Skill start；参数 bounded |
| `toolResult` message | 对应 Tool/MCP/Skill end；结果 bounded |
| error/abort | span/Execution error |
| compaction/session metadata | diagnostic attribute，不伪造成用户 interaction |

Tool start/end 时间缺失时：

- 使用 toolCall 所在 assistant message 和 toolResult timestamp；
- 只有一个 timestamp 时生成零时长或相邻事件推导时长；
- 写入 `goal_plus.timing_fidelity=derived`；
- 禁止伪称精确 TTFT 或 tool duration。

usage 只使用 assistant native usage 或 Goal Plus `pi_metrics.usage_total`。两者都存在时
assistant usage 是 interactions 的权威来源，`pi_metrics` 用于完整性交叉校验，不能
相加。

### 5.4 版本和降级

parser 对已验证的 Pi session schema 建立版本化 fixture。未知 entry：

- 保留 bounded diagnostic count；
- 不映射成错误的 Tool/LLM；
- 如果关键 message/tool schema 不支持，将 session 标记 `unsupported`；
- 如果只有 Goal Plus compact RPC log，则只能生成 summary，不得把 summary 标记为
  full native trace。

### 5.5 与未来 extension trace 去重

若未来 Goal Plus 允许加载 Agent Insight extension，同一 agent session 可能同时有
passive 和 extension trace。优先级：

```text
Pi extension exact trace > Pi native passive trace > Goal Plus usage summary
```

correlation service 按 explicit Goal Plus agent session ID 或 native session ID 选择权威
Execution；低优先级记录保留 ingest audit，但不在 composite trace 重复展示。

## 6. Codex 关联

Codex 不新增 transcript parser，默认复用现有 collector：

- Goal 主会话：`GoalPlusRecord.active_session.session_id` 对应 Codex hook session ID；
- ordinary work item：优先 `agent_id`/native session，其次精确 `task_name`；
- Search candidate：`AgentSessionRecord.host_handle.external_id`、task name 或 Goal Plus
  已保存的 native transcript identity；
- final checker：按 check/work item 的 native ID 或 task name；
- iteration：按 `IterationRecord.agent_session_id` 连接 agent session。

`transcript_path` 只用于计算不可逆 fingerprint 和精确 identity 校验，默认不读取
正文。用户显式开启历史 Codex transcript import 才允许使用现有 Codex parser 的安全
子集；该能力不属于 MVP。

## 7. Correlation service

### 7.1 Link 方法

```text
native_session_id
agent_session_id_attribute
active_session_id
task_name
transcript_fingerprint
explicit_import_identity
```

不提供 `time_window` link method。

### 7.2 优先级

1. Execution 已携带 `goal_plus.agent_session_id`；
2. native session ID 与 source 归属均一致；
3. Goal active session ID 精确命中 Codex/Pi Execution；
4. source 内 task name 唯一命中；
5. transcript/session fingerprint 精确命中；
6. 保持 pending/unresolved。

所有 link 必须在相同用户下，并限定 source。task name 在 source 内不唯一时不能自动
关联。

### 7.3 Link 状态

```text
pending | linked | ambiguous | missing | superseded
```

后台在以下事件后重算 pending link：

- 新 native Execution 保存；
- agent session snapshot 更新；
- Codex/Pi trace snapshot 替换；
- source 完成一次 scan；
- 用户执行 self-check/relink。

## 8. 服务端 API

### 8.1 Semantic ingest

```text
POST /api/ingest/goal-plus/v1/snapshots
```

请求：

```json
{
  "format": "agent-insight.goal-plus-batch",
  "version": 1,
  "source": {
    "sourceId": "gpsrc_01J...",
    "workspaceFingerprint": "sha256:...",
    "collectorVersion": "0.1.0"
  },
  "snapshots": []
}
```

响应：

```json
{
  "accepted": 18,
  "duplicate": 4,
  "rejected": [],
  "retryable": false
}
```

约束：

- 鉴权与用户归属沿用现有 ingest API key；
- 单批默认最多 100 snapshots；
- 单 snapshot 默认最多 256 KiB，整批默认最多 4 MiB；
- snapshot 验证失败逐项返回，不能让合法项因一个重复项全部失败；
- 未知 major version 返回非重试错误；
- 408、429、5xx 为可重试；
- 不信任 client 传入的 user；
- server 再执行字段、长度、绝对路径和 secret 防线。

### 8.2 Query API

建议新增：

```text
GET /api/observe/goal-plus/sources
GET /api/observe/goal-plus/goals
GET /api/observe/goal-plus/goals/:goalId?sourceId=...
GET /api/observe/goal-plus/runs/:runId/trace?sourceId=...
POST /api/observe/goal-plus/relink
```

对外 ID 必须同时携带 `sourceId`，不能只用 `goalId/runId`。

## 9. Prisma 数据模型

### 9.1 GoalPlusSource

```text
id, userId, sourceId, workspaceFingerprint, label,
collectorVersion, sourceSchemaVersion, firstSeenAt, lastSeenAt
```

唯一约束：`(userId, sourceId)`。

### 9.2 GoalPlusGoal

```text
id, sourceDbId, goalPlusId, currentRevision, status, phase,
goalDigest, boundedGoal, policyJson, triageJson, workItemsJson,
finalChecksJson, activeSessionJson, createdAt, sourceUpdatedAt, observedAt
```

唯一约束：`(sourceDbId, goalPlusId)`。revision history 保存在经过 sanitization 的
JSON snapshot；如果后续需要 revision 级查询再拆表，不在 MVP 预先过度建模。

### 9.3 GoalPlusRun

```text
id, sourceDbId, goalDbId, runId, frozenSpecId, sourceRunId,
replacementRunId, state, strategy, metricName, metricDirection,
bestCandidateId, bestScore, selectedCandidateId, selectedIteration,
selectedScore, selectedGitHead, selectedArtifactHash,
invalidationReason, createdAt, invalidatedAt, observedAt
```

唯一约束：`(sourceDbId, runId)`。

### 9.4 GoalPlusCandidate

```text
id, runDbId, candidateId, status, selectedModel, baseGitHead,
bestIteration, bestScore, bestArtifactHash, taskJson, observedAt
```

唯一约束：`(runDbId, candidateId)`。

### 9.5 GoalPlusIteration

```text
id, candidateDbId, iteration, agentSessionId, score, processPassed,
disposition, failureClass, gitHead, ledgerGitHead, artifactHash,
changedFilesJson, metricsJson, createdAt, observedAt
```

唯一约束：`(candidateDbId, iteration)`。

### 9.6 GoalPlusAgentSession

```text
id, runDbId, candidateDbId, agentSessionId, host, role,
nativeSessionId, taskName, transcriptFingerprint, selectedModel,
usageJson, hostMetadataJson, createdAt, sourceUpdatedAt, observedAt
```

唯一约束：`(runDbId, agentSessionId)`。

### 9.7 GoalPlusExecutionLink

```text
id, sourceDbId, goalDbId?, runDbId?, candidateDbId?, agentSessionDbId?,
executionId, role, linkMethod, linkState, priority, linkedAt, updatedAt
```

索引覆盖 `executionId`、`agentSessionDbId`、`goalDbId` 和 `linkState`。同一
agent session 最多一个 active authoritative link；superseded link 保留审计。

### 9.8 GoalPlusSemanticSnapshot

```text
id, sourceDbId, snapshotId, kind, objectKey, contentHash,
sourceSchemaVersion, sanitizedPayloadJson, observedAt, ingestedAt
```

唯一约束：`(sourceDbId, snapshotId)`。保留 bounded ingest audit，用于重新构建投影
和解释 schema 变化；设置数量/保留策略，避免无限保存同一活跃 snapshot 的每次微小
更新。

### 9.9 对现有模型的影响

- 不修改 `Execution.parentExecutionId/rootExecutionId` 语义；
- 不新增 `framework=goal-plus`；
- 不要求向 `Session.interactions` 写 Goal Plus verifier 伪 Tool；
- native Pi passive events 仍由现有 `pi-agent` adapter 生成 Execution/Session；
- composite view 通过 link/domain tables 查询。

## 10. Snapshot 投影事务

服务端处理一批 snapshot 时：

1. 验证 auth、source、format/version 和 payload limits；
2. 对 snapshot ID 去重；
3. 保存 sanitized snapshot audit；
4. 在单 snapshot 事务内 upsert domain projection；
5. 对外键尚未到达的对象保存 pending parent key；
6. 父对象到达后重放 pending projection；
7. 提交后异步触发 correlation/completeness 重算；
8. 单 snapshot 永久失败进入 rejected，不推进本地对应 checkpoint。

snapshot-replace 只更新源 snapshot 拥有的字段，不能把服务端 link、label 或用户配置
覆盖掉。

## 11. Composite Trace

### 11.1 查询树

```text
Goal revision
├── Main native Execution
├── Ordinary work DAG
│   ├── Work item → native Execution
│   └── Final checker → native Execution
└── Search run
    ├── Candidate A lane
    │   ├── Native Execution
    │   ├── Iteration 1 → verifier settlement
    │   └── Iteration 2 → verifier settlement
    ├── Candidate B lane
    ├── Selection
    ├── Promotion
    └── Report metadata
```

### 11.2 UI

新增 Goal Plus 列表/详情入口，详情至少包含：

- Goal header：status、phase、revision、source、completeness；
- Overview：主 Execution、work item 状态、linked runs；
- Candidate lanes：模型、usage、iteration score/disposition、best/selected；
- Native trace drawer：复用现有 Trace 详情组件；
- Decision timeline：selection、invalidation/successor、promotion、report；
- Data quality：missing sessions、unresolved links、timing/content fidelity、collector
  checkpoint。

UI 使用现有共享 design tokens 和组件，不新增 Goal Plus 局部色板。candidate lane 可以
用布局和标签区分，不为每个 candidate 创建任意颜色。

## 12. 完整性与 fidelity

### 12.1 顶层状态

```text
collecting | complete | partial | unsupported
```

### 12.2 分项结果

```ts
interface GoalPlusTraceCompleteness {
  status: 'collecting' | 'complete' | 'partial' | 'unsupported';
  expectedNativeExecutions: number;
  linkedNativeExecutions: number;
  expectedIterations: number;
  observedIterations: number;
  semanticCheckpointCaughtUp: boolean;
  missingCategories: string[];
  timingFidelity: 'exact' | 'mixed' | 'derived' | 'summary-only';
  contentFidelity: 'bounded' | 'metadata-only' | 'mixed';
}
```

### 12.3 Complete 判定

一个终态 Goal/run 成为 `complete` 至少满足：

- Goal current snapshot 和相关 goal events 已扫描；
- Goal active session 或明确的无主会话原因已处理；
- 每个 work item/final checker 的已绑定 native identity 已关联；
- 每个 Search `AgentSessionRecord` 有 authoritative Execution；
- 每个 retained iteration 有唯一 settlement；
- run selected/invalidation/successor 状态与 Goal linked search 一致；
- selected candidate/iteration、best record、promotion/report metadata 交叉校验通过；
- semantic 和 Pi native checkpoints 已追平当前文件 hash/offset；
- 无 ambiguous link 和不可恢复 rejected snapshot。

Pi passive timing 为 `derived` 不会使 status 自动变成 `partial`；它会单独降低
`timingFidelity`。缺 message/tool 内容或 session file 才影响 native completeness。

## 13. 安全与隐私

### 13.1 路径安全

- attach root 必须是用户明确提供的 `.gp` 目录；
- 所有读取目标 resolve 后必须位于 root 或显式 session root；
- 拒绝 symlink、device、socket、FIFO 和路径穿越；
- 不上传 root/session/workspace 绝对路径；
- detach/uninstall 只操作 `~/.agent-insight` 下受管理目录。

### 13.2 内容安全

- 复用 `trace-transport.cjs` 的 secret/path redaction 和长度限制；
- tool 参数/结果、prompt、assistant text 使用 bounded content；
- report、diff、verifier log 和 workspace 默认只上传 hash/大小/相对引用；
- server 对 client 已清洗 payload 再执行第二层校验；
- 日志不记录 API key 和正文。

### 13.3 Hidden-answer

collector 必须忽略：

- gold labels/answers；
- hidden grader command/input/output；
- private dataset path；
- 可向 worker暴露 correctness oracle 的 evaluator 细节。

只允许上传 Goal Plus 已公开给 worker 的 verifier settlement、聚合后的最终 benchmark
统计和不可逆 case identity hash。

## 14. 故障处理

| 故障 | 行为 |
|-|-|
| JSON 正在写入 | 有界重试，checkpoint 不前移 |
| JSON 永久损坏 | rejected diagnostic，source/run partial |
| Pi session append 中 | 只处理完整 JSONL 行，下轮 snapshot-replace |
| Pi session compact/replace | 重读并生成完整 snapshot，按 event ID 去重 |
| API 408/429/5xx | durable spool + 指数退避 |
| API 4xx schema error | rejected，不无限重试 |
| collector crash | 从 checkpoint/spool 恢复 |
| source root 消失 | source offline，历史数据保留 |
| native Execution 晚到 | pending link，后续重算 |
| 一对多歧义 | ambiguous，不按时间猜测 |
| Goal Plus 升级 schema | 支持则 version adapter；不支持则 object unsupported |

## 15. 文件影响面

建议实现落点：

```text
scripts/agent-trace-collectors/goal-plus/
├── goal-plus-collector.cjs
├── install.cjs
├── uninstall.cjs
└── lib/
    ├── source-registry.cjs
    ├── gp-snapshot-parser.cjs
    ├── pi-native-parser.cjs
    ├── semantic-spool.cjs
    └── self-check.cjs

src/app/api/ingest/goal-plus/v1/snapshots/route.ts
src/app/api/ingest/setup/goal-plus/route.ts
src/app/api/observe/goal-plus/...
src/lib/ingest/goal-plus/
├── contracts.ts
├── normalize.ts
├── persist.ts
├── correlate.ts
└── completeness.ts

src/app/.../goal-plus/
src/components/.../goal-plus/
prisma/schema.prisma
test/goal-plus-*.test.ts
test/fixtures/goal-plus/
```

正式实现时以当前仓库结构为准，避免把 domain persistence 塞进 OTLP adapter。

## 16. 备选方案

### A. 修改 Goal Plus，加载 Agent Insight Pi extension

优点是 live timing 更精确；缺点是跨仓耦合、改变 `--no-extensions` 隔离、部署时需要
双方版本协商。本期不采用，可作为可选高 fidelity 模式。

### B. 只解析 `.gp`，不采集 native session

实现简单，但只能得到 usage/score 摘要，不能称为完整 Agent execution trace，不采用。

### C. 把 Goal Plus 当新 framework

会丢失 Codex/Pi 原生语义，并让同一次执行在 framework 维度重复，不采用。

### D. 把 verifier/selection 伪造成 Tool interaction

会污染 Tool/Skill 统计，且无法表达 run/candidate 多对多关系，不采用。

### E. 只用时间和 cwd 关联

并行 candidate 下容易误连，审计不可信，不采用。

## 17. 设计不变量

1. Agent Insight 对 `.gp` 完全只读。
2. Goal Plus 不成为 framework；native Execution 始终属于真实宿主。
3. native Execution 树不因 Goal Plus overlay 被重写。
4. 关联必须使用确定性 identity；歧义宁可 unresolved。
5. telemetry 故障不能影响 Goal Plus 执行结果。
6. 不采集私有 chain-of-thought、credential、workspace 或 hidden gold。
7. `complete` 必须可计算，并与 timing/content fidelity 分开。
