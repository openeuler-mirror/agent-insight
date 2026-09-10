# Goal Plus 观测覆盖层

Goal Plus 集成不是新的 Agent 运行框架，也不接管 Goal Plus 编排。它把 `.gp` 的权威语义与 Agent Insight 已有 Execution 组合为 composite trace，并保持两条数据面的权威边界。

## 架构与数据流

```text
explicitly attached .gp
  ├─ goal/spec/run/candidate/agent-session/report
  │    └─ semantic parser → durable semantic spool
  │         └─ POST /api/ingest/goal-plus/v1/snapshots
  │              └─ Goal Plus domain projection + completeness
  └─ Pi native session
       ├─ worker: referenced by agent-session metadata
       └─ main: exact workspace session dir + native-entry/goal marker
            └─ passive Pi parser → existing canonical OTLP spool
            └─ POST /api/ingest/otel/v1/traces → Execution/Session

existing Codex/Pi Execution ── deterministic correlation ── Goal/Run/Candidate
```

collector 只接受 source registry 中显式 attach 的 canonical `.gp` root。目录遍历跳过符号链接，读取执行 lstat/realpath/root containment 和前后 stat 校验；JSONL 只消费以换行结束的完整记录。Pi 主会话只访问该 attached workspace 精确对应的 Pi project-session 目录，并以 `host_command_invocations.native_entry_id`/`goal_plus_id` 定位，不递归扫描 home。语义与 native spool 均按 API Key 摘要隔离。Pi import checkpoint 在 native spool flush 成功后原子推进，用于保证重复扫描幂等；独立的 uploader checkpoint 仍只在服务端返回 HTTP 2xx 后推进，两者不得合并。

## 代码地图

| 区域 | 入口 | 职责 |
|---|---|---|
| collector | `scripts/agent-trace-collectors/goal-plus/goal-plus-collector.cjs` | attach/list/detach/scan/watch/start/stop/status/self-check，协调双通道 |
| semantic parser | `goal-plus/lib/gp-snapshot-parser.cjs` | allowlist 解析、版本信封、边界化和路径安全 |
| Pi importer | `goal-plus/lib/pi-native-parser.cjs` | native JSONL → Pi canonical Agent/LLM/Tool/MCP/Skill event |
| spool repair | `scripts/repair-goal-plus-pi-spool.cjs` | 对历史 Goal Plus Pi collector/server JSONL 做只读分析或停写压缩 |
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

Goal Plus 后台 watcher 使用 collector managed directory 中独立的 PID、锁和日志。`start` 要求至少一个已 attach source，重复调用幂等；`ensure` 对未配置或无 source 返回可诊断的跳过结果，对失效 PID 则清理并重启。`develop_start.sh`、`start.sh` 和 npm CLI 在 Agent Insight 服务就绪后使用当前发布版本的 collector 执行 `ensure`，因此机器或主服务重启后无需手工恢复 watcher；失败仅输出告警，不阻断主服务，也不接管 Pi/Codex 进程。单次 scan 先完成 native Pi session 的 durable import/upload，再尝试可重试的 semantic upload，避免语义端点超时阻塞主/worker Trace 入队。

Goal Plus collector 的配置优先级为专属环境变量、managed config、通用环境变量。专属变量是 `AGENT_INSIGHT_GOAL_PLUS_API_KEY`、`AGENT_INSIGHT_GOAL_PLUS_BASE_URL`、`AGENT_INSIGHT_GOAL_PLUS_OTLP_ENDPOINT` 和语义端点 `AGENT_INSIGHT_GOAL_PLUS_ENDPOINT`。managed config 存在时，冲突的 `AGENT_INSIGHT_API_KEY`/`AGENT_INSIGHT_OTLP_ENDPOINT` 不得静默覆盖它；诊断只打印 Key 摘要。watcher 指纹覆盖 collector 版本、凭证摘要、端点、host/source 配置和 interval，任一变化均触发受控重启。

native Pi 导入按 source 文件指纹、session descriptor 和每个稳定 event identity 的语义 hash 保存独立 checkpoint。文件及 descriptor 未变化时整段跳过；session 增长或终态变化时只追加新增/更新事件；文件截断或替换时重建该 session 基线。顺序固定为 `spool flush → import checkpoint 原子写入 → uploader`，所以网络失败只留下待上传数据，不会让下一次 5 秒扫描再次追加全部 session。

## Spool 幂等、容量保护与历史修复

服务端只为 `goal-plus:` canonical Pi session 维护 `.trace-event-index-v1` sidecar，并在 session 锁内完成“读取索引、追加、更新索引”。身份键由已认证用户、session ID、`event`/`span` 类型和 event ID（缺失时使用 span ID）组成；语义 hash 只忽略传输时间 `receivedAt`，认证来源升级仍作为有效修订保留。因此完全相同的重传会被跳过，同一事件从 running 更新为 success/failure 等有效修订也不会丢失。sidecar 记录所覆盖的 legacy 文件与 shard 签名，文件被替换或截断时会从 spool 流式重建。session 锁不会按时间抢占存活的本机进程或其他主机所有者，只自动回收已确认退出的本机 PID；无法证明 owner 已退出时失败关闭。单 Goal Plus session 默认最多索引 100,000 个身份（`AGENT_INSIGHT_OTEL_DEDUPE_MAX_IDENTITIES`）；达到上限后拒绝新身份并返回 HTTP 413，collector 因此不会推进 uploader checkpoint。

聚合通过 `visitEventsForSession` 逐行读取 legacy range 和 session shard，不再把整个 JSONL 展开到数组。对 Goal Plus Pi session 的默认上限为 50,000 个唯一事件、64 MiB 保留事件和 16 MiB 单事件，可分别通过 `AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS`、`AGENT_INSIGHT_OTEL_AGG_MAX_RETAINED_BYTES`、`AGENT_INSIGHT_OTEL_AGG_MAX_EVENT_BYTES` 调整。超过上限的 Goal Plus session 记为确定性 `discard` 并推进 consumer checkpoint，避免同一损坏或异常数据形成无限重试/OOM；日志必须带 limit、actual 和 maximum。普通 standalone Pi 及其他框架仍使用流式读取，但不启用这组 Goal Plus 限额或持久去重，维持原来的写入与聚合语义。首次为已有大 Goal Plus spool 建立 sidecar 仍需完整流式扫描，内存有界但可能长时间占用事件循环，因此已发生膨胀的部署应先离线压缩再启动服务。

历史修复工具默认 dry-run，且只处理 `framework=pi-agent`、`sessionId` 以 `goal-plus:` 开头的记录：

```bash
node scripts/repair-goal-plus-pi-spool.cjs --kind collector --path ~/.agent-insight/otel_data/pi-agent
node scripts/repair-goal-plus-pi-spool.cjs --kind server --path ~/.agent-insight/otel_data/traces
```

目录模式逐文件独立压缩，不跨文件合并 identity。实际写入前必须停止 Goal Plus collector/uploader 和 Agent Insight 服务，再增加 `--apply --confirm-writers-stopped`。工具会先预检目录中的全部目标文件；malformed、未换行、单行超过 64 MiB 或目标 identity 超过 1,000,000 时拒绝修改。每个已修改文件都生成同目录、不可覆盖的 `.bak.<timestamp>` 硬链接备份并立即报告；若后续文件失败，之前的成功项仍可审计和恢复。工具不修改 `uploader-checkpoint.json`/`consumer-checkpoint.json`，只报告受影响的相对路径和能安全映射时的新 byte cursor；操作员必须保留 checkpoint 中其他条目，仅核对报告指出的条目后再重启写入方。

## 完整度与保真度

completeness 是独立状态机：

- `collecting`：Goal/run 未终态，或最新 scan checkpoint 未覆盖 Goal 快照；
- `complete`：预期 native role、iteration settlement、selection/report 证据齐全；
- `partial`：已终态但存在明确缺项或歧义；
- `unsupported`：关键 source schema 超出支持范围。

`timingFidelity` 使用 `exact/mixed/derived/summary-only`，semantic snapshot 的 `contentFidelity` 使用 `bounded/metadata-only/mixed`。它们不能被成功/失败状态替代，也不能把缺失数据显示为零。Pi passive importer 的 canonical session 固定为 `goal-plus:<sourceId>:<agentSessionId>`；主会话的 agent session ID 为 `main:<goalId>:<nativeSessionId>:<markerId>`。continuation 重建同一 Execution；低 authority 的重复 link 不进入默认原生 Trace 列表。

Pi adapter 只在根 Agent 带有可靠运行时终态信号时设置 `trace_completed_at`；Goal Plus passive snapshot 还要求明确 runtime terminal state 或 exit code，增量 LLM/Tool snapshot 保持 running。Pi 主对话的 Goal `complete/blocked/abandoned` 只用于确认本次 invocation 已结束，并作为独立 business state 保留；它不决定 Execution 成败。通用 Trace 列表、Goal Plus 列表/详情和 Trace drawer 在页面可见时以 5 秒周期静默重取；同一 Execution 的 tree 更新必须保留用户的选择和展开状态。

Pi passive importer 将 native session 作为正文权威源：保留所有 assistant `thinking`/`text`、后续 user/custom message、tool 参数和 tool result，只执行共享 secret/path 脱敏，不设置固定 2000 字符或二次字符截断。上传器的 batch byte 值只是多事件组包目标；第一条事件超过该值时仍读取完整换行记录并单独上传，成功后才移动 checkpoint。未恢复的 runtime aborted/cancelled/blocked、worker timeout、runner failure 或非零 exit code 会在 Agent event 和 Execution failures 中保留失败证据；已被后续 continuation 恢复的历史中止和 Goal/Run 的业务 blocked 不会把 Execution 标成失败。

## 扩展约束

- 新 schema 先扩展 versioned parser 和合成 fixture；不要直接上传未知原始 JSON。
- Goal Plus 仍是语义权威，Agent Insight 不写 `.gp`、不改 Goal 状态、不触发 Search 或 promotion。
- 不上传 absolute path、workspace、diff、raw log、credential 或 hidden gold；Pi 已写入 native session 的 thinking 视为 trace 正文，脱敏后完整采集，未持久化的内部状态不推断。
- Pi 分类必须复用 `scripts/agent-trace-collectors/shared/pi-trace-helpers.cjs`；不能复制第三套 Tool/MCP 规则。
- 新关联方法必须可审计且确定；不得引入仅依靠时间接近度的 fallback。
