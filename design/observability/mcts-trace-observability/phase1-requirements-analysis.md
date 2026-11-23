# MCTS 执行 Trace 非侵入式接入：需求设计

## 1. 文档信息

| 项目 | 内容 |
|-|-|
| 需求类型 | Feature / Observability |
| 设计状态 | 核心采集与统一安装接入已实现，待真实环境及浏览器验收 |
| 首次分析日期 | 2026-09-21 |
| 非侵入式方案修订日期 | 2026-09-22 |
| 统一安装接入修订日期 | 2026-09-23 |
| Agent Insight 基线 | `a02c9cb56388`（`master`） |
| MCTS 基线 | `f963c345517e`（`rebuild`） |
| 硬约束 | 不修改 MCTS 仓库中的任何源码、脚本、配置文件或依赖 |

## 2. 可行性结论

在“**允许改变启动方式和子进程环境，但不修改 MCTS 项目文件**”的前提下，非侵入式接入可行。

可通过 Agent Insight 提供的外部启动器启动原始 MCTS 命令，并把 MCTS 已有的 `XGOVERNOR_BASE_URL` 临时指向本机透明观测网关。网关转发全部 xGovernor HTTP/SSE 流量，同时旁路提取：

- `lease.client_id`：一次 MCTS run 的稳定身份；
- `runtime_id + turn_id`：Agent turn 的精确归属；
- open/load/checkpoint：runtime 与 checkpoint 的确定性血缘；
- SSE：assistant output、reasoning、Tool activity、usage 和终态；
- MCTS stdout：启动参数、选点、score、最终树和 official result 的白名单摘要。

因此可以得到两类数据：

1. **高可信 Runtime 执行树**：能够准确展示 Coordinator、Author、Solver runtime、Memory Helper 和 Selector，以及通过 checkpoint 形成的父子 runtime 关系。
2. **部分 MCTS 语义摘要**：能够展示 stdout 已明确打印的 node、score、choose、final tree 和 official result。

但在当前 MCTS 外部信号下，以下内容无法完全恢复：

- 并发场景下精确的 `MCTS node_id ↔ runtime_id` 映射；
- 未输出到 stdout 或网络的逐次 harvest、backprop、UCT 数值变化；
- MemoryPool 内部 add/fetch/sync 的完整事件和来源绑定；
- xGovernor SSE 未暴露的 Agent 内部多轮 LLM 细节。

新方案必须把“Runtime 执行树”和“MCTS 语义摘要”分开呈现，不得用时间邻近或请求到达顺序把二者伪造为确定映射。如果验收要求每个 `root/cN/...` 都精确对应某个 runtime，并展示每次 backprop/memory 事件，则在完全不改 MCTS、xGovernor 也不增加观测字段的条件下不可行。

## 3. 非侵入式定义

本需求中的“非侵入式”必须同时满足：

- MCTS 仓库工作区零文件变更。
- 不向 MCTS 注入 `sitecustomize`、monkey patch、Python profiler、动态库或修改后的模块。
- 不修改 xGovernor 服务端代码或协议。
- 原 MCTS 命令及参数保持不变，只由外部启动器包裹执行。
- 只设置 MCTS 已经支持的 `XGOVERNOR_BASE_URL` 子进程环境变量。
- 观测组件、spool、配置和日志全部位于 Agent Insight 数据目录或安装目录。
- 启动器转发原进程的退出码、信号和 stdout/stderr，不改变业务判断。

透明网关会进入网络数据路径，因此它是“零源码侵入”，不是“零运行风险”。方案必须通过极小转发数据面、观测旁路线程、启动前健康检查和失败时 bypass 降低风险；运行中网关进程整体崩溃仍可能中断活跃 SSE，这一残余风险必须在验收中明确。

## 4. 现有可观测缝隙

### 4.1 xGovernor HTTP/SSE

MCTS 的 `xgovernor_client.py` 已通过单一 Base URL 访问以下路径：

| 请求 | 可观察事实 | 用途 |
|-|-|-|
| `POST .../open` | 新 `runtime_id`、runtime kind、conversation、扩展配置 | 创建无父 runtime |
| `POST .../load` | `checkpoint_id -> child runtime_id` | 记录 checkout 血缘 |
| `POST .../checkpoint` | `source runtime_id -> checkpoint_id` | 建立 checkpoint owner |
| `POST .../turns` | runtime、输入、扩展配置；响应含 turn ID | 创建 Agent turn |
| `GET .../turns/:turn/events` | output delta、Tool activity、usage、terminal | 构建执行 Trace |
| `POST .../exec/files/*` | runtime 上的外部控制操作 | 仅记录脱敏类型、耗时和状态 |
| `POST .../close/cancel` | runtime 终态 | 完成 Trace |
| 请求体 `lease.client_id` | `union-<run-id>` | 确定一次 MCTS run |

透明网关不需要理解 xGovernor 的业务实现，只需从已知请求/响应中提取白名单字段，其余内容原样流式转发。

### 4.2 MCTS stdout/stderr

当前代码会稳定输出部分控制语义：

- `▶ startup ...`、`▶ choose iter=... node=...`、`▶ done`；
- `<node> score=... timing=... testcases=...`；
- `▶ final tree` 及 node visits/value；
- `OFFICIAL TEST PASS/FAIL node=...`。

这些行可以由外部启动器 tee 给用户并在副本上去 ANSI 后解析。未匹配白名单的 stdout/stderr 不上传，避免泄露业务正文或凭据。

### 4.3 不能作为权威源的信号

- 现有 xiaoO collector 的 sticky active session 不能用于 MCTS 多 runtime 归属。
- HTTP 请求完成时间和 stdout 行时间不能证明 node 与 runtime 的对应关系。
- 并发 child checkout 的到达顺序不能等价于 MCTS 的 `c0/c1/c2`。
- 最终树的相同 score/value 不能用于反推 runtime。

## 5. 用户目标

- 不修改 MCTS 代码即可在 Agent Insight `/trace` 查看一次 MCTS run。
- 从合成 Coordinator 进入 Author、Solver、Memory Helper 和 Selector 的独立 Trace。
- 查看每个 xGovernor turn 的输入、assistant 输出、Tool summary、Token、耗时和终态。
- 按 checkpoint 血缘查看 Solver runtime 的真实父子关系。
- 查看 MCTS stdout 能够证明的 choose、score、最终树和 official result 摘要。
- 明确区分 confirmed、degraded、unavailable，不能为了视觉完整而推断不存在的关联。
- 采集失败时优先保证 MCTS 原始命令可运行和退出语义不变。
- 在 Agent Insight 安装页把 `MCTS (xGovernor)` 作为独立接入项，通过当前账号 API Key 安装 collector 并生成启动器，不要求目标机器持有 Agent Insight 源码仓库。

## 6. 非目标

- 不要求显示与 MCTS 内部 `Node.node_id` 完全一致的 Runtime 树标签。
- 不通过流量时序猜测并发 child 的 `cN` 编号。
- 不恢复未暴露的 harvest、backprop、MemoryPool 和 UCT 中间状态。
- 不解析任意 pytest/scorer 输出以猜测 score；只接收标准 stdout score 行。
- 不修改 MCTS、xGovernor 或 Agent runtime 以增加观测回调。
- 不把临时 score/official checkout 作为 Agent 节点。
- 一期不新增 Prisma model、摄入 API 或 MCTS 专用页面。
- 一期不合并 xiaoO/Pi 原生 collector 与代理 Trace；避免同一 runtime 双写产生重复 Execution。
- 不因选择 MCTS 自动安装 Pi Agent 或 xiaoO collector；MCTS 的 `--runtime` 是单次运行参数，不是安装时依赖。

## 7. 目标展示模型

```text
MCTS Coordinator（外部采集器合成）
├─ Author runtime（确认后标注）
├─ Solver runtime <short-id>
│  ├─ Solver runtime <short-id>
│  └─ Solver runtime <short-id>
├─ Solver runtime <short-id>
├─ Memory Helper #N（真实 LLM turn，非搜索节点）
└─ Submission Selector（实际启动时）

Coordinator 控制摘要
├─ choose: node=root/c0, iter=1（来自 stdout）
├─ score: node=root/c0/c1, score=...（来自 stdout，默认不绑定 runtime）
├─ final tree: node/visits/value（来自 stdout）
└─ official result（来自 stdout）
```

Runtime 树的边来自 checkpoint owner/load 血缘，具有确定性；MCTS node 摘要来自 stdout，具有语义但通常没有 runtime 绑定。两者在 UI 上并列，不自动合并。

## 8. 数据可信度分级

| 数据 | 可信度 | 依据 |
|-|-|-|
| run identity | confirmed | `lease.client_id` |
| turn 归属 | confirmed | URL/请求/事件中的 `runtime_id + turn_id` |
| checkpoint owner | confirmed | checkpoint 请求 runtime + 响应 checkpoint ID |
| checkout parent | confirmed | load 请求 checkpoint + owner map |
| Solver runtime 父子边 | confirmed | child 发生真实 turn 且 parent checkpoint 唯一 |
| 无父 runtime 属于本 run | confirmed | 同一 lease client ID |
| 初始 Solver | confirmed-after-lifecycle | open + turn + 后续 checkpoint |
| Author | confirmed-after-lifecycle | open + turn + host-side oracle read/sync + 长生命周期且无 checkpoint |
| Selector / Memory Helper | confirmed-by-profile-signature | tools/max turns/profile fingerprint 与已支持版本匹配 |
| stdout node/score/final tree | confirmed-summary | MCTS 明确输出的白名单格式 |
| node ID 与 runtime 的关联 | unavailable，除非出现额外唯一证据 | 当前协议没有共同 ID |
| backprop/memory 内部事件 | unavailable | 无 stdout/网络权威信号 |

任何分类规则未满足时，runtime 显示为 `Unclassified Agent <short-id>`，关系仍可作为 run member 或 checkpoint child 展示，但不能标成具体角色。

## 9. 功能需求

| 编号 | 需求 | 优先级 |
|-|-|-|
| FR-MCTS-NI-001 | 提供 Agent Insight 侧外部启动命令，接受 `-- <原 MCTS 命令和参数>`，不写入 MCTS 工作区 | P0 |
| FR-MCTS-NI-002 | 启动器保存原 upstream URL，启动本地随机端口网关，只对 MCTS 子进程覆盖 `XGOVERNOR_BASE_URL` | P0 |
| FR-MCTS-NI-003 | 网关必须逐字节流式转发普通 HTTP 与 SSE；观测处理失败不得阻塞转发 | P0 |
| FR-MCTS-NI-004 | 从 `lease.client_id` 创建稳定 run/collaboration identity | P0 |
| FR-MCTS-NI-005 | 从 open/load/checkpoint 构建 runtime/checkpoint 血缘 ledger | P0 |
| FR-MCTS-NI-006 | 只有产生真实 turn 的 runtime 才生成 Agent Execution；无 turn 的临时 checkout 只进入控制计数 | P0 |
| FR-MCTS-NI-007 | 从 SSE 采集输入、输出、Tool summary、usage、terminal，并以 runtime/turn 精确去重 | P0 |
| FR-MCTS-NI-008 | 以 checkpoint 血缘上报 Coordinator/Runtime 的 binding 与关系事件，并生成父 Trace `task` 锚点 | P0 |
| FR-MCTS-NI-009 | stdout/stderr 原样转发，只解析固定白名单格式；未匹配正文不上传 | P0 |
| FR-MCTS-NI-010 | node/score/final tree 摘要默认只挂 Coordinator，不通过时间推断 runtime | P0 |
| FR-MCTS-NI-011 | 保存本地 Trace spool、topology ledger 和 relation outbox，重试幂等 | P0 |
| FR-MCTS-NI-012 | 使用现有 OTLP traces、collaboration sessions/events API，上报数据按 API key 用户隔离 | P0 |
| FR-MCTS-NI-013 | 未识别的协议版本/profile 保留 Trace，角色降级为 unknown，不误分类 | P0 |
| FR-MCTS-NI-014 | 启动前网关或 upstream 不可用时默认 bypass，直接执行原命令并明确提示本次无观测 | P0 |
| FR-MCTS-NI-015 | 转发 SIGINT/SIGTERM，返回与 MCTS 子进程一致的退出码 | P0 |
| FR-MCTS-NI-016 | reasoning 正文默认关闭；请求头、系统 prompt、文件内容、exec 命令和 secret 永不落盘 | P0 |
| FR-MCTS-NI-017 | 在 Trace 中显示 capture mode、fidelity 和不可用能力，不声称完整 MCTS 语义 | P1 |

## 10. 非功能需求

| 编号 | 要求 |
|-|-|
| NFR-MCTS-NI-001 | 转发数据面与观测处理面隔离；spool 慢、Insight 不可达或 parser 异常时丢弃/延迟观测而不是阻塞网络 |
| NFR-MCTS-NI-002 | SSE chunk 必须立即转发，不能等完整 event、turn 或响应结束后再回传 |
| NFR-MCTS-NI-003 | 网关不记录 Authorization、Cookie、ext.system_prompt、files content、exec command/env |
| NFR-MCTS-NI-004 | collector 不得要求 root、packet capture、eBPF 或修改系统证书 |
| NFR-MCTS-NI-005 | 透传层增加的本机处理延迟应以 p95/p99 验收，并设置明确预算；具体阈值在开发计划评审确定 |
| NFR-MCTS-NI-006 | spool/outbox 有磁盘配额、已投递清理和 rejected 隔离，不写 MCTS 目录 |
| NFR-MCTS-NI-007 | 所有解析器版本化；未知字段原样转发但不进入观测正文 |
| NFR-MCTS-NI-008 | Agent Insight adapter 从完整 spool 确定性重建快照并使用 `snapshot-replace` |

## 11. 验收边界

### 11.1 可接受的成功标准

1. `git status` 证明 MCTS 仓库在采集前后无新增或修改文件。
2. 使用外部启动器运行原 MCTS 命令，退出码与不带启动器运行一致。
3. Agent Insight 中出现一个 Coordinator 和所有产生 LLM turn 的 runtime Trace。
4. Solver child 按 checkpoint 血缘挂到正确 parent runtime，不受并发完成顺序影响。
5. score/choose/final tree/official result 显示在 Coordinator 摘要中，并标明来源为 stdout。
6. score 没有共同 ID 时不绑定到某个 Solver runtime。
7. 临时评分 checkout 不成为 Agent；Memory Helper 因实际发生 LLM turn 而保留为控制型 Agent。
8. Insight 不可达时本地持久化并重试，不改变 MCTS 结果。

### 11.2 必须明确失败或降级的场景

- upstream 使用当前代理不支持的协议升级：转发继续，解析降级并标记 unsupported。
- checkpoint owner 缺失：child 作为独立 run member，不猜父节点。
- role classifier 证据不足：标记 Unclassified，不猜 Author/Solver。
- stdout 格式变化：不上传该行，保留 Runtime Trace。
- 网关启动失败：默认 bypass 运行并返回“本次未采集”；不得阻断 MCTS。
- 网关在活跃 SSE 中整体崩溃：本次运行可能失败，这是透明代理方案的已知残余风险。

## 12. 安全验收

- MCTS/xGovernor Authorization header 只能在内存中转发，禁止写入日志、spool 或错误正文。
- open/turn 中的 `ext.system_prompt` 只计算内存 fingerprint，禁止持久化正文。
- `files/write` 的 base64 内容、`files/read` 响应正文和 `exec` command/env 不采集。
- turn input、assistant output、Tool summary 需脱敏和截断；reasoning 正文默认关闭。
- stdout 只上传匹配白名单的结构化字段，绝不上传任意未匹配行。
- checkpoint ID 在本地 ledger 使用加密哈希；上传只使用不可逆 digest，不上传原值。
- API key 只写请求头，认证用户只能由 Agent Insight 服务端决定。

## 13. 方案采用条件

满足以下条件时采用本非侵入式方案：

1. 允许用 Agent Insight 启动器包裹原 MCTS 命令。
2. 允许启动器为子进程覆盖已有 `XGOVERNOR_BASE_URL`。
3. 接受 Runtime 血缘树是精确主视图，而 MCTS node 语义是独立、部分摘要。
4. 接受透明网关位于网络数据路径的残余运行风险。

若第 3 条不能接受，即必须精确展示 `root/cN` 与 runtime、每次 backprop/memory 的对应关系，则需要 MCTS 或 xGovernor 增加共同 correlation ID；这与“完全不修改 MCTS/xGovernor”约束冲突，不能通过外部推断安全解决。

## 14. 源码证据范围

- MCTS：`testcases_union/core/main.py`、`mcts_coordinator.py`、`mcts_log.py`、`submission_selector.py`。
- xGovernor client：`testcases_union/res/xgovernor_client.py`、`agents.py`。
- Agent Insight：`src/lib/ingest/otel/*`、`src/lib/collaboration/*`、`scripts/xiaoo-trace-collector/*`。

后续 MCTS/xGovernor 协议变化时，应先更新支持矩阵与分类规则，再更新 collector，不得在未知版本上继续声称 confirmed。
