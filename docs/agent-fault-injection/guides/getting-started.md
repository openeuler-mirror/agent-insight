# 快速开始

在本机启用 Agent FI（故障注入 + 采集）的最短路径。远程 Insight 负责任务 / Judge / 展示；本机 **FI Worker** 认领任务并驱动同机的 OpenCode / xiaoO。

## 流程

```mermaid
flowchart LR
  Setup[Install_Worker] --> Agent[Have_OpenCode_or_xiaoO]
  Agent --> Task[Create_task_in_Insight]
  Task --> Run[Worker_injects]
  Run --> Judge[Server_Judge]
```

| 步 | 做什么 | 细节在哪 |
|----|--------|----------|
| 1 | 本机安装并常驻 FI Worker | 下文；逐步过程见 [local-install-process.md](local-install-process.md) |
| 2 | 同机已装 OpenCode 和/或 xiaoO | 向导靠 Worker inventory 选平台 / 模型 |
| 3 | Insight 设置页配置激活模型 | Judge 依赖；无模型仍可 collect，结论可能是 `judge_skipped` |
| 4 | 新建注入任务，等 Run 与 Judge | 产品操作见 [user-guide](../../user-guide/observability/fault-injection.md) |

FI **不**启动 RAS。环内检测若在场，是本机已装 RAS 的结果，与本次注入任务解耦。

## 1. 安装 Worker

打开 `/agent-ras/fault-injection/tasks/new`，在无 Worker 提示中复制命令并在本机执行（**以页面生成的为准**）：

```bash
curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash
```

- `$API_KEY` 必须是**当前登录账号**的 API Key（Worker 心跳按用户隔离）。
- setup / `--start` 后台常驻，打印 pid 与日志路径后即可关终端；日志默认 `~/.agent-insight/fault-injection/worker.log`。前台排障加 `--foreground`。
- 换**另一账号**的 Key 重跑 setup 会按新凭证重启 Worker；同一 Key/host 再跑则保持已有进程。
- 无在线 Worker 时无法选平台、无法下一步。刷新新建任务页，平台应变为可选。

仓内开发等价：`npx agent-insight install-fault-injection --start`（或 `node scripts/install-fault-injection.js --start`）。检查：`--check`。

## 2. 跑第一次注入

侧栏 **故障注入与评测** → **注入任务** → **新建任务**：平台 → 故障 + 子模式 → 配置。创建后为 `queued`，由本机 Worker claim。

任务详情里看「注入流程」与 Judge。本页不管环内检测开关——那是侧栏 **可靠性能力**（`/agent-ras/fault-modes`）。

## 下一步

| 目的 | 打开 |
|------|------|
| curl 落盘、Worker 生命周期、排障 | [local-install-process.md](local-install-process.md) |
| 向导、停止任务、冒烟用例、本地 CLI | [user-guide · 故障注入与评测](../../user-guide/observability/fault-injection.md) |
| 内置故障有哪些 | [fault-catalog.md](../designs/modules/fault-catalog.md) |
| 某平台怎么注入 | [OpenCode](../designs/modules/opencode-platform-adaptation.md) · [xiaoO](../designs/modules/xiaoo-platform-adaptation.md) |
