# Goal Plus 观测接入

Agent Insight 把 Goal Plus 作为编排观测覆盖层：Goal Plus 仍负责 Goal、work item、Search、candidate 和最终检查，Agent Insight 只读采集 `.gp`，不会修改 Goal Plus 状态或工作区文件。

## 前置条件

- Agent Insight 服务可由 collector 访问，并已取得当前用户的 API Key。
- Node.js 版本不低于 22.19.0。
- 需要观测的 Goal Plus 工作区已经生成 `.gp` 目录。
- collector 只接受显式 `.gp` 根目录；符号链接、越出根目录的路径和非普通文件会被拒绝。

## 安装和首次采集

在“安装指导”中勾选 **Goal Plus** 后，继续选择实际宿主：Pi、Codex 或 Pi + Codex。安装页会展示 Goal Plus 本体的对应前置命令，并自动把需要的原生采集器加入安装计划：

| Goal Plus 宿主 | Goal Plus 本体 | Agent Insight 自动依赖 |
|-|-|-|
| Pi | `./install.sh --pi` | Pi Agent Collector |
| Codex | `./install.sh --codex` | Codex Collector |
| Pi + Codex | 两条命令都执行 | Pi Agent Collector + Codex Collector |

Agent Insight 只展示 Goal Plus 本体的安装指引，不会自动执行外部仓库脚本，也不会改变 Pi/Codex collector 的 hook、OTLP、Execution ID 或 adapter 行为。旧的、不带 `goalPlusHosts` 的 Goal Plus 安装命令仍只安装 Goal Plus collector。

安装器把 Goal Plus collector 放在 `~/.agent-insight/collectors/goal-plus/`；macOS/Linux 同时安装 `~/.local/bin/goal-plus-collector`，Windows 使用 `node %USERPROFILE%\.agent-insight\collectors\goal-plus\goal-plus-collector.cjs`。

如果在包含 `.gp` 的工作区根目录执行一键接入命令，脚本会自动 attach 该目录、执行首次 scan 并启动 watcher；从其他目录安装时使用下面的命令显式登记工作区。

macOS/Linux 示例：

```bash
goal-plus-collector attach /absolute/path/to/workspace/.gp --label my-goal-workspace
goal-plus-collector scan
goal-plus-collector start --interval-ms 5000
goal-plus-collector status
```

`attach` 对同一个 canonical root 幂等；`list` 查看已登记 source，`detach <sourceId>` 只移除 Agent Insight 的登记，不删除 `.gp`。先执行一次 `scan` 可检查语义对象、Pi session 和上传诊断，再使用 `start` 启动独立后台 watcher。`start` 重复执行不会创建第二个进程，`stop` 停止它；日志和 PID 只保存在 Goal Plus collector 的 managed directory。需要前台观察时仍可使用 `watch --interval-ms 5000`，按 Ctrl+C 正常停止。

没有 attach 任何 `.gp` 时，`start` 和 `self-check` 不会报告 ready。Goal Plus 安装或 watcher 失败会显示 `PARTIAL`，已经安装并运行的 Pi/Codex 原生采集器不会被回滚或停止。

## 页面与数据口径

侧边栏“运行观测 → Goal Plus”提供 source 筛选和 Goal 列表。详情页包含：

- 总览：Goal 状态、work-item 依赖、Search run 和关联摘要；
- 候选通道：candidate、iteration、模型、分数和结算状态；
- 原生 Trace：打开已确定关联的 Codex/Pi Execution；
- 数据质量：分别显示 completeness、timing fidelity 和 content fidelity。

`collecting` 表示 Goal/run 尚未终态或本轮扫描 checkpoint 尚未追上；`complete` 表示预期语义、结算证据和 native Execution 已齐；`partial` 表示终态但仍有明确缺项；`unsupported` 表示观察到不支持的关键 schema。完整度不等同于执行成功，失败或 selection blocked 也可以完整。

Pi worker 使用 `--no-extensions` 时，collector 从 Goal Plus 明确记录的 native session 被动还原 Agent、LLM、Tool、MCP、Skill 和 usage。其时间通常标记为 `derived`。Codex 与其他已有采集通道保持原有行为；Goal Plus 可使用 host metadata 中的 Codex conversation + turn 构造既有 execution ID，且只匹配 `framework=codex`。关联仍只使用 native/session/execution ID 或唯一的确定性任务名，不按时间接近度猜测。

## 隐私、失败恢复与卸载

collector 不上传绝对路径、workspace 内容、diff、完整日志、密钥、隐藏标准答案或私有推理。普通字段有长度和数组上限；超过单快照限制时降级为 `metadata-only`。上传先写按 API Key 隔离的本地 spool，HTTP 2xx 后才推进 checkpoint；429、5xx 或断网会重试并保留 pending，确定性拒绝会进入 rejected 目录。

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
