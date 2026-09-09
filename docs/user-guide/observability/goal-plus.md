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

没有 attach 任何 `.gp` 时，`start` 和 `self-check` 不会报告语义增强 ready，但只要所选 Pi/Codex 原生采集器安装成功，Goal Plus native Trace 仍显示 `READY`。语义 collector 安装、scan 或 watcher 失败会单独显示为可选增强不可用，不会把 native Trace 降为 `PARTIAL`，也不会回滚或停止 Pi/Codex 原生采集器。只有所选宿主的原生采集器未安装成功时，Goal Plus native Trace 才显示 `NOT READY`。

## 页面与数据口径

侧边栏“运行观测 → Goal Plus”提供 source 筛选和 Goal 列表。详情页包含：

- 总览：Goal 状态、work-item 依赖、Search run 和关联摘要；
- 候选通道：candidate、iteration、模型、分数和结算状态；
- 原生 Trace：打开已确定关联的 Codex/Pi Execution；
- 数据质量：分别显示 completeness、timing fidelity 和 content fidelity。

`collecting` 表示 Goal/run 尚未终态或本轮扫描 checkpoint 尚未追上；`complete` 表示预期语义、结算证据和 native Execution 已齐；`partial` 表示终态但仍有明确缺项；`unsupported` 表示观察到不支持的关键 schema。完整度不等同于执行成功，失败或 selection blocked 也可以完整。

Goal Plus 列表、详情和已打开的 Trace 会在浏览器页面可见时每 5 秒静默刷新；通用链路追踪列表采用相同刷新周期。运行中的 Pi/Goal Plus Trace 只有收到根 Agent 的明确终态后才显示完成，刷新期间会保留当前选中的节点和展开状态。collector 扫描、OTLP 入队和服务端消费仍会带来数秒级延迟，因此这里的“实时”是持续增量可见，而不是逐 token 推送。

Pi worker 使用 `--no-extensions` 时，collector 从 Goal Plus 明确记录的每个 native session 被动还原 Agent、LLM、Tool、MCP、Skill 和 usage，不因 worker 是 candidate、work item 或 final checker 而漏采。Pi 中输入 `/goal-plus` 的主对话也会从当前 attached 工作区对应的 Pi session 目录定向补采，并按 Goal Plus invocation 分段；它不会扫描其他工作区或仅按时间猜测。其时间通常标记为 `derived`。Codex 与其他已有采集通道保持原有行为；Goal Plus 可使用 host metadata 中的 Codex conversation + turn 构造既有 execution ID，且只匹配 `framework=codex`。关联仍只使用 native/session/execution ID 或唯一的确定性任务名。

Pi/Codex 原生 Trace 的输入、输出、工具参数和工具结果会先递归脱敏，再默认完整写入本地 spool 并转换为 OTLP，不再使用固定的 2000 字符正文上限。Goal Plus Pi 被动导入还会保留 native session 中已写入的 thinking、后续 user/custom message 和完整 tool result。即使单条事件超过默认上传批次大小，也会整条单独上传，不会因此卡住或二次截断；诊断错误摘要上限仍然生效。该行为只影响升级采集器后重新扫描或新产生的 Trace，历史记录中已经写入且源 session 已删除的 `[TRUNCATED ...]` 内容无法恢复。

## 隐私、失败恢复与卸载

collector 不上传绝对路径、workspace 内容、diff、完整日志、密钥或隐藏标准答案。Pi native session 已持久化的 thinking 会作为 Trace 正文脱敏后采集；这不代表能够恢复宿主未保存的内部状态。Goal/Run 等语义快照仍有长度和数组上限，超过单快照限制时降级为 `metadata-only`，该限制不截断 Pi native Trace 正文。上传先写按 API Key 隔离的本地 spool，HTTP 2xx 后才推进 checkpoint；429、5xx 或断网会重试并保留 pending，确定性拒绝会进入 rejected 目录。

诊断命令：

```bash
goal-plus-collector self-check
goal-plus-collector scan --no-upload
```

卸载默认保留 spool 以便恢复：

```bash
node ~/.agent-insight/collectors/goal-plus/uninstall.cjs
```

仅在确认不再需要待上传数据时增加 `--purge-spool`。卸载和 purge 都不会修改 `.gp`。
