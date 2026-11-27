---
title: "快速开始"
description: "介绍 FI Worker 的安装、平台准备和首次故障注入流程，帮助用户查看采集事实并按实验配置运行评估器。"
keywords: ["Agent FI", "故障注入", "Worker 安装", "可靠性评测"]
changefreq: monthly
---

<a id="快速开始"></a>
在本机启用 Agent FI（故障注入 + 采集）的最短路径。远程 Insight 负责任务 / 采集记录 / 展示；本机 **FI Worker** 认领任务并驱动同机的 OpenCode / xiaoO。

## 流程

```mermaid
flowchart LR
  Setup[Install_Worker] --> Agent[Have_OpenCode_or_xiaoO]
  Agent --> Task[Create_task_in_Insight]
  Task --> Run[Worker_injects]
  Run --> Trace[Business_Trace_Ready]
  Trace --> Evaluator[Selected_Experiment_Evaluator]
```

| 步 | 做什么 | 细节在哪 |
|----|--------|----------|
| 1 | 本机安装并常驻 FI Worker | 下文；逐步过程见 [local-install-process.md](../../../how-to/reliability/agent-fault-injection/local-install-process.md) |
| 2 | 同机已装 OpenCode 和/或 xiaoO | 向导靠 Worker inventory 选平台 / 模型 |
| 3 | 为被测 Agent 配置模型；按需配置 Insight 评测模型 | FI 采集不调用 LLM；选用 LLM 评估器时才使用评测模型 |
| 4 | 在实验中配置 FI，等待 Trace 并运行所选评估器 | 产品操作见 [user-guide](../../../how-to/reliability/agent-fault-injection/run-injection.md) |

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

实验详情里查看执行、Trace 与所选评估器结果；FI 不再自动运行独立 Judge。本页不管环内检测开关——那是侧栏 **可靠性能力**（`/agent-ras/fault-modes`）。

## 下一步

| 目的 | 打开 |
|------|------|
| curl 落盘、Worker 生命周期、排障 | [local-install-process.md](../../../how-to/reliability/agent-fault-injection/local-install-process.md) |
| 向导、停止任务、冒烟用例、本地 CLI | [user-guide · 故障注入与评测](../../../how-to/reliability/agent-fault-injection/run-injection.md) |
| 内置故障有哪些 | [fault-catalog.md](../../../reference/reliability/agent-fault-injection/fault-catalog.md) |
| 某平台怎么注入 | [OpenCode](../../../explanation/reliability/agent-fault-injection/modules/opencode-platform-adaptation.md) · [xiaoO](../../../explanation/reliability/agent-fault-injection/modules/xiaoo-platform-adaptation.md) |
