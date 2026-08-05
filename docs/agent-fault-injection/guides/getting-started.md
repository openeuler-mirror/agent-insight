# 入门

> **拓扑**：远程 Insight 负责任务/Judge/展示；本机 **FI Worker** 认领并执行注入。设计见 [server-client-split.md](../designs/server-client-split.md)。

1. 安装 FI + Worker 配置：
   ```bash
   export AGENT_INSIGHT_HOST=http://127.0.0.1:3000
   export AGENT_INSIGHT_API_KEY=<your-key>
   npx agent-insight install-fault-injection --start
   # 或 curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" | bash
   ```
2. Insight 设置页配置激活模型（Judge 依赖；无模型时仍可 collect，评判为 `judge_skipped`）
3. 本机安装 OpenCode 和/或 xiaoo（须与 Worker 同机）
4. 打开 `/agent-ras/fault-injection`：
   - **故障模式**：目录表按子模式拆行（`?` 说明）；点「注入方式」看 Skill
   - **注入任务** → **新建任务**：三步向导（平台 → 故障+submode → 配置）；行级停/再跑/删
   - 详情轮询进度 → Run：「注入流程」四节点 + 调用树

创建默认 **非** dry-run。Dry-run 仅在服务端 stub（不经 Worker）。真实任务保持 `queued` 直至本机 Worker claim。

向导中的 Agent / Model 来自 **在线 Worker** 的 heartbeat inventory；无 Worker 时 health/platforms 返回引导安装（不静默假目录）。

故障激活后会写入 `RasAnomalyEvent`（`payload.source=fault_injection`），在 **可靠性观测** `/agent-ras/trace` 可见（需与登录用户一致）。Dry-run 不会写入观测。

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
  --timeout-seconds 90 --no-judge
```

禁止把仓库根当作 workspace base。
