---
title: "故障注入与评测"
description: "安装 FI Worker、创建注入任务、查看 Run 与 Judge，并与环内 RAS 能力区分。"
---

# 故障注入与评测

故障注入（Agent FI）用于在**真实 Agent 宿主**上主动植入故障模式，采集轨迹后由 Insight **服务端 Judge** 给出可信结论。编排与展示在平台侧；注入执行在本机 **FI Worker**。

> **Note**
> 侧栏入口在 **AgentRAS 可靠性** 下的「故障注入与评测」（`/agent-ras/fault-injection/tasks`）。  
> 它与「可靠性能力」页（`/agent-ras/fault-modes`）不同：后者管**环内检测/恢复**开关；本页管**主动注入评测任务**。

## 和环内 RAS 的区别

| | 故障注入（本页） | 可靠性能力 / 可靠性观测 |
|--|------------------|-------------------------|
| 目的 | 主动注入故障，验证检测/恢复与 Agent 行为 | 环内实时检测与自动恢复；事后回放异常 |
| 入口 | `/agent-ras/fault-injection/tasks`、`/faults` | `/agent-ras/fault-modes`、`/agent-ras/trace` |
| 执行位置 | 本机 FI Worker + 被测 Agent | Agent 进程内 RAS（inproc） |
| 评判 | Insight 服务端 Judge（轨迹证据） | RAS 处置列 / 异常摘要条（非 FI Judge） |

设计关系见 [Insight · RAS · FI](../../agent-fault-injection/designs/ras-fi-insight-relationship.md)。

## 前置条件

1. 可访问 Insight 看板，并已登录（邮箱账号）
2. 在 **模型注册** 中配置激活模型（Judge 依赖；无模型时仍可 collect，评判可能为 `judge_skipped`）
3. 本机已安装 **OpenCode** 和/或 **xiaoO**（须与 Worker 同机）
4. 当前账号的 **API Key**（设置 / 安装指导中创建；Worker 心跳按用户隔离）

## 最短路径

### 1. 安装本机 FI Worker

打开 `/agent-ras/fault-injection/tasks/new`。若无在线 Worker，页面会给出安装命令；在本机执行（**以页面生成的命令为准**）：

```bash
curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash
```

- `$API_KEY` 必须是**当前登录账号**的 API Key。
- setup 会把 Worker **后台常驻**；日志默认 `~/.agent-insight/fault-injection/worker.log`。前台排障可加 `--foreground`。
- 无在线 Worker 时，新建任务向导中平台不可选、无法下一步。

更多细节：[FI getting-started](../../agent-fault-injection/guides/getting-started.md)。

### 2. 新建注入任务

侧栏 **故障注入与评测** → **注入任务** → **新建任务**，三步向导：

1. **平台**（来自在线 Worker 的 inventory，枚举本机真实 agents/models）
2. **故障模式 + 子模式**
3. **配置**（提示词、超时等）

创建后任务一律 `queued`，由本机 Worker claim 后执行。

### 3. 看故障目录（可选）

标题右上角 **故障目录** → `/agent-ras/fault-injection/faults`：按子模式拆行；点「注入方式」可看 Skill 说明。  
不要与侧栏「可靠性能力」混淆。

### 4. 查看 Run 与 Judge

进入任务详情，轮询进度。Run 页展示「注入流程」节点与调用树；Judge 在服务端基于轨迹给出结论（含 `inconclusive` 等语义）。

本机产物目录（排障用；权威数据在平台 DB）：

```text
~/.agent-insight/fault-injection/artifacts/<runId>/
```

### 5. 停止任务

- `queued`：立即 stopped  
- `collecting`：置 `stopRequested`，Worker 杀本机进程组  

## 真跑冒烟建议

| 平台 | fault | submode |
|------|-------|---------|
| opencode | `thinking-dead-loop` | `2`（逻辑死循环） |
| xiaoo | `tool_repeat_dead_loop` | `2`（unknown） |

超时建议 60–180s。本地 CLI 排障也可用（不经 Worker）：

```bash
python3 -m agent_fault_injection.cli run \
  --platform opencode --agent build \
  --fault thinking-dead-loop --submode 2 \
  --prompt "执行场景2 / case2 / 逻辑死循环" \
  --workspace ~/.agent-insight/fault-injection/workspaces \
  --output-dir ~/.agent-insight/fault-injection/artifacts \
  --timeout-seconds 90
```

禁止把仓库根当作 workspace base。

## 常见注意点

- **注入不会**为「可靠性观测」合成假 RAS 异常事件；观测页以真实轨迹 / RAS 上报为准。
- 部分运行时注入能力（如工具参数改写）可能**仅部分平台**支持；目录与设计文档会标明差异。
- Worker 换账号 Key 重跑 setup 时会按新凭证重启；同 Key/host 再跑则保持已有进程。

## 下一步

- 环内异常回放： [链路追踪 / 可靠性观测](./view-traces)
- 开发者新增故障模式： [Lane A 指南](../../agent-fault-injection/guides/lane-a-add-fault.md)
- 模块设计入口： [docs/agent-fault-injection](../../agent-fault-injection/README.md)
