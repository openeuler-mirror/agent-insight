# Claude Code 上下文免 `/exit` 补传设计

## 背景与目标

现有补传器只注册 `SessionEnd` hook。Claude Code 官方 OTel 可以在会话进行中持续上报基础事件，但系统提示词、hook `additionalContext`、工具输出正文和子 Agent 映射只会在会话退出后补传，所以长驻交互会话在 Agent Insight 上长期缺少这些数据。

本次改动的目标是：

- 主 Agent 每轮回答完成后自动补传，不要求用户执行 `/exit`。
- 子 Agent 完成或本轮发生 API 错误时也触发补传。
- hook 快速返回，不把网络延迟叠加到 Claude Code 交互上。
- 上传失败后保留任务，后续 hook 或 `SessionEnd` 自动重试。
- 长会话只扫描 transcript 新增部分，避免每轮全量扫描。
- 保留 `SessionEnd` 同步补传作为最终兜底。

本次不修改服务端补传 API、数据库结构和现有正文长度上限；超长正文分片属于独立的数据契约改造。

## 方案

### Hook 触发

安装器幂等注册四类 hook：

| Hook | 行为 | 目的 |
|---|---|---|
| `Stop` | 快速入队 | 主 Agent 每轮完成后补传 |
| `SubagentStop` | 快速入队 | 子 Agent 完成后尽快补传映射和内部工具输出 |
| `StopFailure` | 快速入队 | API 错误结束本轮时仍补传已落盘内容 |
| `SessionEnd` | 同步抽取并上传 | 会话退出前最终兜底 |

`Stop` 不使用 `PostToolUse`：工具调用产生在同一轮内，主 Agent 的 `Stop` 已能在轮末一次性收齐，避免每次工具调用都启动上传器。

### 队列与后台 worker

实时 hook 只执行三个本地操作：

1. 校验 `session_id` 和 `transcript_path`。
2. 原子写入 `~/.agent-insight/claude_context_queue/` 下按 session 合并的任务文件。
3. 启动 detached Node worker 后立即退出。

worker 使用进程锁串行排空队列。任务上传成功后删除；失败则原样保留。相同 session 的多次 hook 会合并成一个最新任务，因为每次处理都会从本机文件中收集当前已落盘的全部新内容。

### 增量扫描与 checkpoint

现有 checkpoint 除已上传内容 hash 外，新增：

- transcript 路径；
- 已成功处理到的字节偏移；
- 已识别的 Agent/Task tool-use ID。

扫描器只读取上次成功偏移之后的 JSONL。只有本轮所有待传项目成功上传，才推进偏移；失败时保留旧偏移，下一次重扫并依靠 hash 去重。文件被截短或路径变化时自动从头扫描。

### 失败语义

- hook 输入无效：安静退出，不影响 Claude Code。
- worker 已存在：新任务留在队列，由现有 worker 或退出后的补偿 worker处理。
- 网络失败：本次任务保留；已成功批次写入 hash checkpoint，未成功批次下次重试。
- 进程异常退出：锁包含 PID；后续 worker 会回收无存活进程持有的陈旧锁。
- `SessionEnd`：仍直接执行上传；即使后台队列尚未处理，hash checkpoint 也保证幂等。

## 验证范围

- hook 安装、升级、卸载均不破坏用户已有 hook，且重复执行幂等。
- 入队不执行网络请求，任务原子落盘并按 session 合并。
- worker 成功删除任务，失败保留任务，死锁可回收。
- transcript 首次扫描和追加扫描只返回新增内容。
- 现有系统提示词、hook 上下文、工具输出、子 Agent 映射回归测试全部通过。
- 在 `119.3.152.42:3000` 上运行真实 Claude Code 会话，不执行 `/exit`，确认一轮结束后系统提示词、hook 上下文、工具调用和子 Agent 数据已落库。
