# Goal Plus 观测接入：需求分析

- 状态：提案
- 关联项目：Agent Insight
- 基线提交：`679630181999`
- 创建时间：2026-09-02

## 1. 结论

> 2026-09-21 安装体验优化：Goal Plus 继续是 orchestration overlay，不再作为用户可选
> framework 或独立安装步骤。Pi Agent 安装包内置 Agent Insight 自有的休眠观察器；仅当
> Pi 中真实执行 `/goal-plus` 并能用 `.gp` 内 Goal/start-session 证据确认归属时自动激活。
> 本轮只修改 Agent Insight，不要求 Goal Plus 仓库改代码。普通 Pi 与任何检测/增强失败都
> 保持原生主 Trace 可用。

Agent Insight 可以在不要求 Goal Plus 改代码的前提下接入 Goal Plus，并采集一条
可审计的完整执行轨迹：

- Codex 路径复用现有 Codex hooks 与原生 OTel collector；
- Pi 主会话复用现有 Pi extension；
- Goal Plus 启动的 Pi worker 因带有 `--no-extensions`，不能依赖现有 Pi
  extension，改由 Agent Insight 被动读取 Goal Plus 持久化的 Pi native session；
- Goal、work item、Search run、candidate、iteration、verifier、selection、
  promotion 等编排语义由 Agent Insight 只读解析 `.gp/` durable state；
- 通过 Goal Plus 已保存的 native session ID、task name、transcript/session file 和
  `agent_session_id` 进行确定性关联。

这里的“完整”指可审计完整：能看到触发 Goal Plus 的 Pi 主对话，并从 Goal 追溯到
每个公开 worker 的全部已持久化消息、LLM、工具、usage 以及 Goal Plus 的验证和选择
结果。Pi native session 已写入的正文和 thinking 均保留，不施加固定字符截断；仍会
移除 credential、绝对路径、hidden answer 等敏感信息。宿主从未持久化的内部状态无法
恢复，必须显示为缺失而不是伪造。

Goal Plus 不是新的 Agent framework。接入后原生 Execution 仍分别标记为
`codex` 或 `pi-agent`；Goal Plus 是覆盖在这些 Execution 上的编排语义层。

## 2. 背景

Agent Insight 已经具备两条成熟的宿主采集链：

- [Codex CLI 与 IDE Trace 采集器](../issue-159-codex-trace-collectors.md)通过
  lifecycle hooks 与原生 OTel 双通道采集 Codex；
- [Pi Agent Trace 采集器](../issue-158-pi-agent-trace-collector.md)通过 Pi
  extension 采集 Agent、LLM、Tool、Skill、MCP 和 SubAgent。

Goal Plus 是运行在 Codex/Pi 上的长任务编排 runtime。它把权威状态持久化到
工作区 `.gp/`，主要包括：

```text
.gp/
├── goal-plus/<goal-id>/goal.json
├── goal-plus/<goal-id>/events.jsonl
├── specs/<spec-id>/frozen_spec.json
├── runs/<run-id>/run.json
├── runs/<run-id>/agent_sessions/*.json
├── runs/<run-id>/candidates/<candidate-id>/candidate.json
├── runs/<run-id>/promotion/
├── runs/<run-id>/report.md
├── host-sessions/pi/
└── host-logs/
```

这些文件包含 Agent Insight 当前缺少的领域语义：Goal revision、work DAG、frozen
spec、candidate lane、verifier iteration、score、disposition、selection、promotion
和 report。

Goal Plus 同时已经保存可用于关联的宿主信息：

- `GoalPlusRecord.active_session.session_id` 与 transcript path；
- work item 的 `task_name`、`agent_id` 与 transcript path；
- Search `AgentSessionRecord.agent_session_id`；
- `host_handle.external_id`、`task_name` 和 metadata；
- Pi worker 的 native session ID、session file 和累计 usage；
- iteration 对应的 `agent_session_id`。

因此，Agent Insight 不需要侵入 Goal Plus runtime，也不需要让 Goal Plus 主动上报
网络 telemetry。

## 3. 当前缺口

### 3.1 Agent Insight 不理解 Goal Plus 语义

现有 `Execution` 能表达主/子 Agent、模型、token 和 interactions，但不能表达：

- 一个 Goal 的多个 revision；
- Goal Mode work item DAG；
- 一个 Goal 关联的多个 Search run；
- candidate、iteration 和 verifier settlement；
- run invalidation 与 successor；
- selection、promotion 和最终报告。

如果只看现有 Trace，用户能看到调用了 Goal Plus MCP 工具，却不能回答“哪个候选被
验证了几次、分数如何变化、为何最终选它”。

### 3.2 Goal Plus Pi worker 绕过现有 extension

Goal Plus 的 Pi worker 使用：

```text
pi --mode rpc --approve --session-dir <dir> --session-id <id>
   --no-extensions -e <goal-plus.ts>
```

所以全局安装的 Agent Insight Pi extension 不会加载到 candidate、普通 work item
和 final checker 进程中。直接复用现有 Pi extension 无法覆盖这些 worker。

不过 Goal Plus 为 worker 指定了稳定 native session ID，并将 session file 放在
`.gp/host-sessions/pi/` 或记录到 `host_handle.metadata.pi_metrics.session_file`。
Agent Insight 可以只读解析 native session，生成与现有 `pi-agent` adapter 兼容的
canonical events。这样无需改 Goal Plus 的扩展隔离策略。

Pi 主对话也存在一个不同的绕过路径：Goal Plus 扩展命令通过 `sendMessage(...,
{ triggerTurn: true })` 直接启动 Agent turn，不触发 Agent Insight extension 的
`before_agent_start`，因此实时采集器不会建立当前 task。collector 必须依据
`host_command_invocations.native_entry_id` 与 Pi session 中的 `goal-plus-*` custom
message 确定性定位主会话，并按相邻 Goal Plus invocation 分段被动导入。

### 3.3 现有 Trace 与 Goal Plus 状态没有关联模型

现有 `Execution.parentExecutionId/rootExecutionId` 表示宿主原生调用树，不能安全地
复用为 Goal/run/candidate 关系。强行重写父子关系会破坏现有 Trace、Skill 统计和
subagent 展示。

需要独立 overlay/link 模型，在保持 native Execution 树不变的情况下连接 Goal Plus
领域对象。

### 3.4 “完整”缺少可计算定义

当前没有机制区分以下情况：

- Goal 仍在运行，collector 尚未追平；
- Goal 已结束，但某个 Pi session file 丢失；
- native trace 完整，但 Pi 精确开始时间不可恢复；
- 仅有 Goal Plus score/usage 摘要，没有消息/tool 内容；
- collector 版本不支持当前 Goal Plus schema。

产品必须显示完整性和 fidelity，而不是只凭有无记录判断成功。

## 4. 用户场景

### US-01 查看 Goal 全貌

用户打开一个 Goal Plus Goal，可以看到 Goal revision、当前 phase、主 Agent
Execution、work DAG 或 Search runs，以及最终状态。

### US-02 查看并行候选

用户可以按 candidate lane 查看每个 Search worker 的 native Execution、LLM/tool
过程、verifier iterations、score 曲线、失败原因和 best iteration。

### US-03 解释选择与 promotion

用户可以从 selected candidate 追溯到具体 iteration、Git head、artifact hash、
verifier settlement 和 promotion gate，而不是只看到最终 report。

### US-04 采集 Goal Plus Pi worker

即使 Goal Plus 使用 `--no-extensions`，Agent Insight 仍能从 native Pi session
恢复消息、LLM usage、tool call/result 和最终回复，并关联到 candidate。

### US-05 判断数据是否完整

用户可以看到 `collecting/complete/partial/unsupported`，以及缺失的是 native
session、语义 snapshot、关联信息、内容还是精确 timing。

### US-06 采集历史运行

用户显式 attach 一个已有 `.gp` 目录后，可以导入仍存在的历史 Goal、run、candidate
和 native session；无法恢复的字段被标明，而不是伪造。

## 5. 功能需求

| 编号 | 需求 |
|-|-|
| FR-001 | Agent Insight 提供显式 attach/scan/watch Goal Plus `.gp` root 的本地 collector |
| FR-002 | collector 只读解析 Goal、goal events、frozen spec、run、candidate、agent session、promotion 和 report metadata |
| FR-003 | collector 为每个被登记 root 生成 Agent Insight 管理的稳定 source ID，不要求修改 `.gp` |
| FR-004 | Codex 主会话按 `active_session.session_id` 关联现有 Codex Execution |
| FR-005 | Codex work item/Search worker 按 task name、native session ID 或 transcript fingerprint 关联 |
| FR-006 | Pi Goal Plus worker 从 native session file 生成 `framework=pi-agent` 的 Execution snapshot |
| FR-007 | Pi continuation 对同一 Goal Plus agent session 执行 snapshot-replace，不产生重复 Execution |
| FR-008 | Goal Plus iteration 按 `agent_session_id` 关联到对应 native Execution |
| FR-009 | 新增 Goal Plus source、goal、run、candidate、iteration、agent session 和 execution link 持久化模型 |
| FR-010 | 新增版本化 semantic snapshot ingest API，支持幂等、乱序与重放 |
| FR-011 | 提供 Goal/run composite trace 查询，保持现有 Execution 原生父子树不变 |
| FR-012 | UI 展示 Goal、work DAG、candidate lanes、verifier、selection、promotion 和 native trace |
| FR-013 | 计算 completeness、missing categories、timing fidelity 和 content fidelity |
| FR-014 | collector 支持历史 one-shot scan 与持续 watch 两种模式 |
| FR-015 | collector 与服务端故障不得阻塞或修改 Goal Plus 执行 |
| FR-016 | 卸载或 detach 只停止 Agent Insight 采集，不删除 `.gp` 和 Goal Plus native sessions |
| FR-017 | Pi Goal Plus 主对话按 native entry ID/goal ID 从当前工作区的 Pi session 目录确定性发现、分段并导入 |
| FR-018 | 每个 `.gp/runs/*/agent_sessions/*` 中可定位的 Pi worker，不论 candidate/work-item/final-checker 角色，均生成独立完整 Execution |
| FR-019 | Pi native message、thinking、tool 参数与结果不使用固定字符截断，超出上传批次目标的单条 JSONL 仍可完整发送 |

## 6. 非功能需求

| 编号 | 需求 |
|-|-|
| NFR-001 | Goal Plus 目录访问必须只读，不写 goal/run/candidate/session 文件 |
| NFR-002 | 不递归扫描 home 或磁盘；只访问用户显式登记的 root |
| NFR-003 | API key、spool、checkpoint 和 source 按 Agent Insight 账号隔离 |
| NFR-004 | 语义 snapshot 以 source + object key + content hash 幂等 |
| NFR-005 | native events 复用 durable spool、指数退避和递归脱敏；批次字节目标不得截断或阻塞单条大事件 |
| NFR-006 | 处理半写 JSON、原子替换、文件删除、session append 和进程重启 |
| NFR-007 | 不因 Goal Plus 接入改变非 Goal Plus Codex/Pi Trace 结果 |
| NFR-008 | 默认不上传绝对路径、credential、完整 diff/log/workspace 或 hidden answer |
| NFR-009 | schema/version 不支持时停止解析该对象并报告 `unsupported`，不得猜字段 |
| NFR-010 | 大型历史目录扫描有批量、速率和本地 spool 容量上限 |

## 7. 范围

### 7.1 本期范围

- Agent Insight 新增 Goal Plus 本地 collector；
- Agent Insight 新增 semantic snapshot API、Prisma 模型和 correlation service；
- Agent Insight 新增 Pi native session 被动 importer；
- 复用现有 Codex/Pi OTLP adapter 和 Execution 存储；
- 增加 Goal/run 查询和 composite trace UI；
- 增加 setup、attach、detach、self-check 和用户/开发者文档。

### 7.2 明确不改

- 不修改 Goal Plus runtime、MCP tools、state machine 或 verifier；
- 不要求 Goal Plus 加 observer extension、HTTP client 或 telemetry thread；
- 不把 `goal-plus` 注册成 `FrameworkAdapter`；
- 不重写现有 Execution 的 parent/root 关系；
- 不读取 candidate workspace 源码或 verifier 私有输入；
- 不将 Agent Insight 状态回写 `.gp`；
- 不让 Agent Insight 参与 candidate selection 或 promotion 决策。

### 7.3 可选后续增强

如果未来 Goal Plus 提供官方 append-only run event ledger 或 observer extension
allowlist，Agent Insight 可以增加更高精度的 live timing，但本期设计不依赖它们。

## 8. 完整性边界

| 能力 | Codex | Pi 主会话 | Goal Plus Pi worker |
|-|-|-|-|
| 用户/助手消息 | hooks/OTel | native session 定向补采，完整 | native session，完整 |
| LLM model/usage | 原生 OTel 优先 | extension | native session assistant usage |
| Tool call/result | hooks/OTel | extension | native session toolCall/toolResult |
| 精确 Tool 起止时间 | 原生事件可用时精确 | extension 精确 | 可能只有结束时间，标记 derived |
| Skill/SubAgent | 现有 adapter | 现有 adapter | 按 native tool 语义解析，无法确认时降级 generic tool |
| Goal/run/candidate/verifier | `.gp` overlay | `.gp` overlay | `.gp` overlay |
| Pi 已持久化 thinking | 不适用 | 采集并脱敏 | 采集并脱敏 |

“complete”不等于所有 fidelity 都是 exact。完整性与 timing/content fidelity 必须分开
展示。

## 9. 验收标准

| 编号 | 验收标准 |
|-|-|
| AC-001 | attach 一个 `.gp` 后，Agent Insight 能显示 Goal、revision、work items 和 linked runs |
| AC-002 | Codex Goal 主会话和每个 Search candidate 均通过确定性 ID 关联，禁止纯时间匹配 |
| AC-003 | Pi Goal Plus worker 在 `--no-extensions` 下仍生成包含 message/LLM/tool/usage 的 Execution |
| AC-004 | Pi 同 session continuation 更新同一 Execution，重复扫描不会增加重复 interactions |
| AC-005 | 2 candidate × 2 iteration 场景准确显示 4 个 verifier settlement、score、disposition 和 Git/artifact 标识 |
| AC-006 | selection、promotion 和 report 可从 Goal 页面追溯到 selected iteration 与 native Execution |
| AC-007 | 断网、服务端 500、collector 重启后可重放且服务端无重复对象 |
| AC-008 | 丢失一个 Pi session file 时 run 标记 `partial` 并列出具体 agent session，不伪造 trace |
| AC-009 | 未知 Goal Plus schema 标记 `unsupported`，其余 source 和 native Trace 不受影响 |
| AC-010 | payload 不含 API key、绝对路径、完整 verifier log、workspace 内容或 hidden gold |
| AC-011 | 未 attach Goal Plus 时，现有 Codex/Pi collector、adapter、Trace 页面行为不变 |
| AC-012 | detach/uninstall 不修改或删除任何 `.gp` 文件 |
| AC-013 | `/goal-plus` 触发的 Pi 主对话在 Goal Plus 与链路追踪页面可见，并与对应 Goal 确定性关联 |
| AC-014 | `.gp` 中所有带 native Pi session 的 agent session 均有对应 Execution；中止/非零退出不得显示为正常成功 |
| AC-015 | 超过 2000 字符及超过默认上传批次字节目标的 native 正文往返后内容长度与源 session 一致（脱敏替换除外） |
| AC-016 | Pi Execution 状态只反映运行时结果；Goal/Run 业务 blocked 单独展示，普通 Pi 接入行为保持不变 |

## 10. 已知前置问题

当前基线上 Pi adapter 有两项 Skill 映射测试失败：预期 invoked Skill 非空，实际为
空数组。该问题不阻塞本文设计评审，但必须在实现 Goal Plus Pi importer 的验收前
修复，否则 Goal Plus Pi worker 的 Skill 信息无法声明完整。
