# 入门

> **拓扑**：远程 Insight 负责任务/Judge/展示；本机 **FI Worker** 认领并执行注入。设计见 [server-client-split.md](../designs/server-client-split.md)。

1. 安装 FI + Worker（**以页面生成的命令为准**）：
   - 打开 `/agent-ras/fault-injection/tasks/new`，在无 Worker 提示中复制 setup 命令并在本机执行；或：
   ```bash
   curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash
   ```
   - `$API_KEY` 必须是**当前登录账号**的 API Key（Worker 心跳按用户隔离）。
   - setup/`--start` 会把 Worker **后台常驻**，打印 pid 与日志路径后退出终端；日志默认 `~/.agent-insight/fault-injection/worker.log`。需要前台排障时加 `--foreground`。
   - 若本机已有 Worker，用**另一账号**的 Key 重跑 setup 时会按新凭证自动重启；同一 Key/host 再跑则保持已有进程。
2. Insight 设置页配置激活模型（Judge 依赖；无模型时仍可 collect，评判为 `judge_skipped`）
3. 本机安装 OpenCode 和/或 xiaoo（须与 Worker 同机）
4. 打开侧栏「故障注入与评测」（默认 `/agent-ras/fault-injection/tasks`）：
   - **注入任务** → **新建任务**：三步向导（平台 → 故障+submode → 配置）；行级停/再跑/删
   - 标题右上角 **故障模式** → `/agent-ras/fault-injection`：目录表按子模式拆行（`?` 说明）；点「注入方式」看 Skill
   - 详情轮询进度 → Run：「注入流程」四节点 + 调用树

任务创建后一律 `queued`，由本机 Worker claim 后执行。无在线 Worker 时平台不可选、无法下一步；请先完成步骤 1。

向导中的 Agent / Model 来自 **在线 Worker** 的 heartbeat inventory；无 Worker 时 health/platforms 返回引导安装（不静默假目录）。

故障激活后，注入细节在 **FI Run** 页查看。可靠性观测 `/agent-ras/trace` 以正常轨迹上报（Execution）为准；**不再**为注入激活合成 `RasAnomalyEvent`。

停止：queued 立即 stopped；collecting 置 `stopRequested`，Worker 杀本机进程组。产物：`~/.agent-insight/fault-injection/artifacts/<runId>/`（本机；权威数据在 Prisma）。

## 真跑验收故障

| 平台 | fault | submode |
|------|-------|---------|
| opencode | `thinking-dead-loop` | `2`（逻辑死循环） |
| xiaoo | `tool_repeat_dead_loop` | `2`（unknown） |

超时建议 60–180s。

Artifact 根目录：`~/.agent-insight/fault-injection/artifacts/`。

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
