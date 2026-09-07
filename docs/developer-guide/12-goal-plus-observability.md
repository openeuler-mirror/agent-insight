# Goal Plus 观测覆盖层

Goal Plus 集成不是新的 Agent 运行框架，也不接管 Goal Plus 编排。它把 `.gp` 的权威语义与 Agent Insight 已有 Execution 组合为 composite trace，并保持两条数据面的权威边界。

## 架构与数据流

```text
explicitly attached .gp
  ├─ goal/spec/run/candidate/agent-session/report
  │    └─ semantic parser → durable semantic spool
  │         └─ POST /api/ingest/goal-plus/v1/snapshots
  │              └─ Goal Plus domain projection + completeness
  └─ Pi native session referenced by agent-session metadata
       └─ passive Pi parser → existing canonical OTLP spool
            └─ POST /api/ingest/otel/v1/traces → Execution/Session

existing Codex/Pi Execution ── deterministic correlation ── Goal/Run/Candidate
```

collector 只接受 source registry 中显式 attach 的 canonical `.gp` root。目录遍历跳过符号链接，读取执行 lstat/realpath/root containment 和前后 stat 校验；JSONL 只消费以换行结束的完整记录。语义与 native spool 均按 API Key 摘要隔离，服务端确认后才推进 checkpoint。

## 代码地图

| 区域 | 入口 | 职责 |
|---|---|---|
| collector | `scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs` | attach/list/detach/scan/watch/start/stop/status/self-check，协调双通道 |
| semantic parser | `goal-plus/lib/gp-snapshot-parser.cjs` | allowlist 解析、版本信封、边界化和路径安全 |
| Pi importer | `goal-plus/lib/pi-native-parser.cjs` | native JSONL → Pi canonical Agent/LLM/Tool/MCP/Skill event |
| distribution | `src/app/api/ingest/setup/goal-plus/` | 确定性 ZIP、SHA-256 校验安装器和只读 asset route |
| install profile | `src/lib/ingest/setup/install-profile.ts` | Goal Plus Pi/Codex 宿主校验、native collector 依赖展开和去重 |
| ingest | `src/lib/ingest/goal-plus/contracts.ts`、`persist.ts` | envelope 校验、服务端二次脱敏、幂等审计与投影 |
| correlation | `src/lib/ingest/goal-plus/correlate.ts` | Execution 确定性关联、重关联和 authority 选择 |
| completeness/query | `completeness.ts`、`query.ts` | 批量完整度计算与 composite read model |
| UI | `src/app/(main)/goal-plus/` | source/goal 总览及四个详情 tab |

专项测试位于 `test/goal-plus-{collector,contract,distribution}.test.ts`；合成 fixture 位于 `test/fixtures/goal-plus/.gp`，不得替换为用户真实数据。

## 语义 ingest 契约

`POST /api/ingest/goal-plus/v1/snapshots` 使用 `x-witty-api-key` 认证。batch `format=agent-insight.goal-plus-batch`、`version=1`，最多 100 个 snapshot、请求体最多 4 MiB、单 snapshot 最多 256 KiB。snapshot identity 为：

```text
gpsnap_ + sha256(sourceId \u001f kind \u001f objectKey \u001f contentHash)
```

支持 `goal`、`goal_event`、`frozen_spec`、`run`、`candidate`、`agent_session`、`best`、`report_meta`。客户端只发送 allowlist 投影；服务端仍递归移除 secret/hidden/path 字段并记录 redaction audit。未知 snapshot 可逐项拒绝，合法项仍可接受；同一 snapshot ID 重传幂等。父对象迟到时，服务端按 kind 顺序重放该 source 尚未投影的 snapshot。

读取接口均按 user + source 隔离：

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/observe/goal-plus/sources` | source 与对象计数 |
| GET | `/api/observe/goal-plus/goals` | Goal 列表和批量 completeness |
| GET | `/api/observe/goal-plus/goals/:goalPlusId` | Goal composite detail |
| GET | `/api/observe/goal-plus/runs/:runId/trace` | run 对应的去重 native Execution |
| POST | `/api/observe/goal-plus/relink` | 对用户 source 重跑确定性关联 |

## 持久化模型

`GoalPlusSource` 是隔离和 checkpoint 根。`GoalPlusGoal`、`GoalPlusRun`、`GoalPlusCandidate`、`GoalPlusIteration`、`GoalPlusAgentSession` 保存可查询投影；`GoalPlusSemanticSnapshot` 保存幂等审计和脱敏后的信封；`GoalPlusExecutionLink` 把上述对象关联到既有 `Execution`。外部 key 始终包含 source scope，绝不把不同 `.gp` 中同名 run/candidate 合并。

新增 Execution 入库后，`saveExecutionRecord` 以非阻断方式触发 Goal Plus relink；语义 ingest 后也会重关联该 source。关联优先级为明确 native/session/execution ID，其次是被动 Pi canonical session ID，再其次是 source 内唯一 deterministic task name。Codex host metadata 可携带 `codexConversationId`、`codexTurnId` 或完整 `codexExecutionId`，关联器按既有 `<conversation>:turn:<turn>` 规则匹配，并按宿主限制 `framework`。相同优先级多个候选标记 `ambiguous`，低优先级候选标记 `superseded`；禁止 time-window-only 关联。

## 安装组合与故障隔离

`frameworks` 继续表示用户选择的组件，`goalPlusHosts=pi,codex` 声明已经运行 Goal Plus 的 Trace 来源，而不是 Goal Plus 本体的安装目标。共享 install profile 在服务端展开 effective frameworks：Pi 加入 `pi-agent`，Codex 加入 `codex`，已存在的依赖不重复加入。不带 host 的旧 `frameworks=goal-plus` 保持 semantic-only 行为。安装页和生成脚本不得展示或执行 Goal Plus 仓库的安装命令；Agent Insight 只配置观测组件。

组合安装继续调用既有 Pi/Codex 子安装器；不得复制或修改 native collector core、adapter、OTLP endpoint、Execution ID 和父子树。宿主 profile 的主就绪状态由所选 Pi/Codex native collector 决定：任一所需 native collector 未完成时为 `NOT READY`；全部完成时为 `READY`。Goal Plus semantic collector 在 native collector 之后作为可选增强安装，缺少 `.gp` 或其安装、scan、watcher 失败只单独报告 semantic enrichment 状态，不降低 native Trace 的 `READY`，也不回滚已安装的 native collector。无宿主的 legacy semantic-only 命令继续沿用原 `PARTIAL` 口径。

Goal Plus 后台 watcher 使用 collector managed directory 中独立的 PID、锁和日志。`start` 要求至少一个已 attach source，重复调用幂等；`stop` 和卸载只处理 Goal Plus watcher，不接管 Pi/Codex 进程。

## 完整度与保真度

completeness 是独立状态机：

- `collecting`：Goal/run 未终态，或最新 scan checkpoint 未覆盖 Goal 快照；
- `complete`：预期 native role、iteration settlement、selection/report 证据齐全；
- `partial`：已终态但存在明确缺项或歧义；
- `unsupported`：关键 source schema 超出支持范围。

`timingFidelity` 使用 `exact/mixed/derived/summary-only`，`contentFidelity` 使用 `bounded/metadata-only/mixed`。它们不能被成功/失败状态替代，也不能把缺失数据显示为零。Pi passive importer 的 canonical session 固定为 `goal-plus:<sourceId>:<agentSessionId>`，continuation 重建同一 Execution；低 authority 的重复 link 不进入默认原生 Trace 列表。

## 扩展约束

- 新 schema 先扩展 versioned parser 和合成 fixture；不要直接上传未知原始 JSON。
- Goal Plus 仍是语义权威，Agent Insight 不写 `.gp`、不改 Goal 状态、不触发 Search 或 promotion。
- 不上传 absolute path、workspace、diff、raw log、credential、hidden gold 或 private chain-of-thought。
- Pi 分类必须复用 `scripts/agent-trace-collectors/shared/pi-trace-helpers.cjs`；不能复制第三套 Tool/MCP 规则。
- 新关联方法必须可审计且确定；不得引入仅依靠时间接近度的 fallback。
