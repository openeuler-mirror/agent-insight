# Goal Plus 观测接入

Agent Insight 把 Goal Plus 作为编排观测覆盖层：Goal Plus 仍负责 Goal、work item、Search、candidate 和最终检查，Agent Insight 只读采集 `.gp`，不会修改 Goal Plus 状态或工作区文件。

## 前置条件

- Agent Insight 服务可由 collector 访问，并已取得当前用户的 API Key。
- Node.js 版本不低于 22.19.0。
- Goal Plus 已经安装在实际运行它的 Pi、Codex 或两者中；Agent Insight 不负责安装或修改 Goal Plus。
- 如果还需要 Goal、Run、Candidate 等编排语义，Goal Plus 工作区需已生成 `.gp` 目录。原生 Trace 采集不依赖 `.gp`。
- 可选语义 collector 只接受显式 `.gp` 根目录；符号链接、越出根目录的路径和非普通文件会被拒绝。

## 安装和首次采集

在“安装指导”中勾选 **Goal Plus** 后，继续选择实际的 Trace 来源：Pi、Codex 或 Pi + Codex。选择的是已经运行 Goal Plus 的 Agent，不是 Goal Plus 的安装方式。Agent Insight 只把需要的原生采集器加入安装计划：

| Goal Plus Trace 来源 | Agent Insight 配置的采集器 |
|-|-|
| Pi | Pi Agent Collector |
| Codex | Codex Collector |
| Pi + Codex | Pi Agent Collector + Codex Collector |

安装命令不会执行 Goal Plus 仓库的安装脚本，也不会改变 Goal Plus 本体。Pi/Codex collector 继续使用原有 hook、OTLP、Execution ID 和 adapter 行为，因此已有的普通 Pi/Codex Trace 采集逻辑不受影响。配置完成后，用户继续在 Pi/Codex 中按原方式执行已经安装的 Goal Plus 即可。旧的、不带 `goalPlusHosts` 的 Goal Plus 安装命令仍只安装语义 collector，以保持兼容。

除原生 Trace collector 外，安装器还会尝试安装可选的 Goal Plus 语义 collector，用于补充 Goal、Run、Candidate 等编排信息。它位于 `~/.agent-insight/collectors/goal-plus/`；macOS/Linux 同时安装 `~/.local/bin/goal-plus-collector`，Windows 使用 `node %USERPROFILE%\.agent-insight\collectors\goal-plus\goal-plus-collector.cjs`。

如果在包含 `.gp` 的工作区根目录执行一键接入命令，脚本会自动 attach 该目录、执行首次 scan 并启动 watcher；从其他目录安装时可使用下面的命令显式登记工作区。这一步只启用语义增强，不是采集 Pi/Codex 原生 Trace 的前置条件。

macOS/Linux 示例：

```bash
goal-plus-collector attach /absolute/path/to/workspace/.gp --label my-goal-workspace
goal-plus-collector scan
goal-plus-collector start --interval-ms 5000
goal-plus-collector status
```

`attach` 对同一个 canonical root 幂等；`list` 查看已登记 source，`detach <sourceId>` 只移除 Agent Insight 的登记，不删除 `.gp`。先执行一次 `scan` 可检查语义对象、Pi session 和上传诊断，再使用 `start` 启动独立后台 watcher。`start` 重复执行不会创建第二个进程，`stop` 停止它；日志和 PID 只保存在 Goal Plus collector 的 managed directory。Agent Insight 的 `develop_start.sh`、`start.sh` 和 npm CLI 启动路径会在服务就绪后执行幂等的 `ensure`：已登记 source 时自动恢复因机器或服务重启留下的失效 watcher，未配置或尚未 attach 时安静跳过，恢复失败只告警而不会阻止主服务启动。需要前台观察时仍可使用 `watch --interval-ms 5000`，按 Ctrl+C 正常停止。

watcher 每轮只导入上次成功落盘后新增或发生状态更新的 Pi 事件；源文件没有变化时整段跳过。网络中断只会留下待上传数据，不会让下一轮扫描再次复制完整 session。修改 API Key、服务地址、Trace 来源或扫描间隔后，`ensure` 会重启 watcher；撤销 API Key 时会停止仍持有旧配置的 watcher。配置优先级是 Goal Plus 专属环境变量、安装器 managed config、通用环境变量。需要临时覆盖时使用 `AGENT_INSIGHT_GOAL_PLUS_API_KEY`、`AGENT_INSIGHT_GOAL_PLUS_BASE_URL`、`AGENT_INSIGHT_GOAL_PLUS_OTLP_ENDPOINT` 或 `AGENT_INSIGHT_GOAL_PLUS_ENDPOINT`，避免通用的 Pi/Codex 配置意外串入 Goal Plus watcher。

Pi uploader 会优先发送当天分区，并在每轮只处理有限批次，所以升级前留下的大 backlog 不再持续阻塞新 Trace。上传锁采用原子发布，旧版本异常退出留下的空锁、损坏锁或本机死进程锁会自动恢复；存活进程和其他主机持有的锁不会被抢占。`goal-plus-collector status` 的 `uploader.state` 应为 `free` 或暂时性的 `held-local`；`invalid`、`orphaned`、`recovery-blocked` 会使状态不再显示 ready，并在 scan 日志中给出 `pi_upload_blocked` 诊断。

Pi RPC worker 完成一个 dispatch 后，Goal Plus 会主动关闭常驻 RPC 进程；由此产生的退出码 `143`/`-15` 在已有 completed handoff、且没有 timeout/runner failure 时属于正常收尾，不显示为失败。若同一退出码伴随预算超时或 runner 异常，则仍显示运行失败，并给出明确的超时或 runner 错误。升级后的 watcher 会增量修订旧误判，只更新状态发生变化的 Agent 事件，不重复上传整条 Trace。

没有 attach 任何 `.gp` 时，`start` 和 `self-check` 不会报告语义增强 ready，但只要所选 Pi/Codex 原生采集器安装成功，Goal Plus native Trace 仍显示 `READY`。语义 collector 安装、scan 或 watcher 失败会单独显示为可选增强不可用，不会把 native Trace 降为 `PARTIAL`，也不会回滚或停止 Pi/Codex 原生采集器。只有所选宿主的原生采集器未安装成功时，Goal Plus native Trace 才显示 `NOT READY`。

## 观测界面状态与数据口径

当前版本暂不在侧边栏展示 Goal Plus 观测入口，未完成的观测界面不作为当前展示功能对外引导。Goal Plus collector、语义 ingest、原生 Trace 导入、持久化和关联仍正常运行，页面源码也继续保留，供后续完善后重新开放。

服务端还会把每个 Goal 中的逻辑主会话与 worker 投影为跨 Session 协作关系。该能力不要求升级或改造 Goal Plus collector，也不会改变 Pi/Codex 原生 Trace：主 Trace 唯一时关联到具体执行，主 Trace 尚未到达时保留待关联状态，发现多个主会话时明确标记歧义而不会任选一个父级。Pi 会以 active native Session 精确选择本次 passive canonical 主 Trace，历史主 Trace 不会覆盖当前关联；原生 collector 产生 `<nativeSessionId>__taskN` 时，只有 query 明确以 `/goal-plus` 开头且基础 Session ID 唯一命中同一 Goal，才会作为主 Trace 的只读显示别名。独立的协作图前端入口本期仍不开放；但对于两端都已唯一关联的 Goal Plus 关系，通用链路追踪的 **仅主 Agent** 列表隐藏独立 worker 行，详情在查询时把 worker 只读展示为主 Trace 下的 **TASK → 子 Agent** 子树，并标注 **Goal Plus 编排**；切换到 **仅子 Agent** 或 **主 Agent + 子 Agent** 仍可查到 worker。这个展示不会写回原始 Session 或 Execution，也不会推断未经采集证据确认的具体启动调用位置；无法唯一关联时仍保持独立 Trace。

预留的详情页设计包含：

- 总览：Goal 状态、work-item 依赖、Search run 和关联摘要；
- 候选通道：candidate、iteration、模型、分数和结算状态；
- 原生 Trace：打开已确定关联的 Codex/Pi Execution；
- 数据质量：分别显示 completeness、timing fidelity 和 content fidelity。

`collecting` 表示 Goal/run 尚未终态或本轮扫描 checkpoint 尚未追上；`complete` 表示预期语义、结算证据和 native Execution 已齐；`partial` 表示终态但仍有明确缺项；`unsupported` 表示观察到不支持的关键 schema。完整度不等同于执行成功，失败或 selection blocked 也可以完整。

预留的 Goal Plus 列表、详情和已打开的 Trace 在浏览器页面可见时每 5 秒静默刷新；通用链路追踪列表采用相同刷新周期。运行中的 Pi/Goal Plus Trace 只有收到根 Agent 的明确运行时终态后才显示完成，刷新期间会保留当前选中的节点和展开状态。链路追踪的执行状态只反映宿主运行是否正常结束：Goal `blocked` 或 Run `selection_blocked` 仍保留在 Goal Plus 详情数据中，但主 Pi 会话正常返回时 Trace 显示成功；worker timeout、runner failure、非零退出或未恢复的最终中止才显示失败。collector 扫描、OTLP 入队和服务端消费仍会带来数秒级延迟，因此这里的“实时”是持续增量可见，而不是逐 token 推送。

Pi worker 使用 `--no-extensions` 时，collector 从 Goal Plus 明确记录的每个 native session 被动还原 Agent、LLM、Tool、MCP、Skill 和 usage，不因 worker 是 candidate、work item 或 final checker 而漏采。Pi 中输入 `/goal-plus` 的主对话也会从当前 attached 工作区对应的 Pi session 目录定向补采，并按 Goal Plus invocation 分段；它不会扫描其他工作区或仅按时间猜测。其时间通常标记为 `derived`。Codex 与其他已有采集通道保持原有行为；Goal Plus 可使用 host metadata 中的 Codex conversation + turn 构造既有 execution ID，且只匹配 `framework=codex`。关联仍只使用 native/session/execution ID 或唯一的确定性任务名。

Pi/Codex 原生 Trace 的输入、输出、工具参数和工具结果会先递归脱敏，再默认完整写入本地 spool 并转换为 OTLP，不再使用固定的 2000 字符正文上限。Goal Plus Pi 被动导入还会保留 native session 中已写入的 thinking、后续 user/custom message 和完整 tool result。即使单条事件超过默认上传批次大小，也会整条单独上传，不会因此卡住或二次截断；诊断错误摘要上限仍然生效。该行为只影响升级采集器后重新扫描或新产生的 Trace，历史记录中已经写入且源 session 已删除的 `[TRUNCATED ...]` 内容无法恢复。

## 隐私、失败恢复与卸载

collector 不上传绝对路径、workspace 内容、diff、完整日志、密钥或隐藏标准答案。Pi native session 已持久化的 thinking 会作为 Trace 正文脱敏后采集；这不代表能够恢复宿主未保存的内部状态。Goal/Run 等语义快照仍有长度和数组上限，超过单快照限制时降级为 `metadata-only`，该限制不截断 Pi native Trace 正文。上传先写按 API Key 隔离的本地 spool，HTTP 2xx 后才推进 checkpoint；429、5xx 或断网会重试并保留 pending，确定性拒绝会进入 rejected 目录。

诊断命令：

```bash
goal-plus-collector self-check
goal-plus-collector scan --no-upload
```

如果升级前已经出现 spool 异常膨胀，应先停止 Goal Plus collector/uploader 和 Agent Insight 服务，再在项目目录中执行只读检查：

```bash
node scripts/repair-goal-plus-pi-spool.cjs --kind collector --path ~/.agent-insight/otel_data/pi-agent
node scripts/repair-goal-plus-pi-spool.cjs --kind server --path ~/.agent-insight/otel_data/traces
```

默认只生成报告，不写文件。确认报告后，分别增加 `--apply --confirm-writers-stopped` 才会压缩；工具只处理 Goal Plus 产生的 Pi 记录，不改普通 Pi/Codex 或其他框架数据。目录模式按文件独立处理，修改前先预检全部文件；每个被修改的 JSONL 都会留下不可覆盖的 `.bak.<timestamp>` 备份。工具不会自动修改 `uploader-checkpoint.json` 或 `consumer-checkpoint.json`，需按报告只校正对应文件的 byte cursor，并保留其他条目，之后再重启服务。首次直接启动新版服务也能以有界内存读取旧数据，但面对数 GB 历史 spool 仍可能长时间阻塞，因此推荐先离线压缩。

上述持久去重、容量限制和历史修复只针对 session ID 以 `goal-plus:` 开头的 Pi 数据。仅安装 Pi、不安装 Goal Plus 时，Pi collector、事件写入和聚合口径保持不变。

卸载默认保留 spool 以便恢复：

```bash
node ~/.agent-insight/collectors/goal-plus/uninstall.cjs
```

仅在确认不再需要待上传数据时增加 `--purge-spool`。卸载和 purge 都不会修改 `.gp`。
