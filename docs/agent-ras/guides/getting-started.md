# 快速开始

在宿主中启用 Agent RAS（环内检测 + 恢复）的最短路径。RAS 随宿主进程运行，**不**启独立 RAS HTTP 端口。人机查看走 Agent Insight 旁路事件，失败不挡环内 abort/notice。

## 流程

```mermaid
flowchart LR
  Pick[Choose_platform] --> Install[Install_or_dependency]
  Install --> Config[Enable_config]
  Config --> Run[Run_agent]
  Run --> Observe[Optional_Insight_UI]
```

| 平台 | 怎么装 | 下一步 |
|------|--------|--------|
| openjiuwen / jiuwenclaw | 宿主 `config.yaml` 的 `agent_ras:` + 工厂深挂载 | [platform-openjiuwen.md](platform-openjiuwen.md) |
| OpenCode | `install-ras` 写入插件 + libpython inproc | [platform-opencode.md](platform-opencode.md) |
| xiaoO | `install-ras` 写入 hooker；mid-stream 用 Daemon SSE | [platform-xiaoo.md](platform-xiaoo.md) |
| 安装命令本机逐步（curl / 目录树 / 排障） | | [local-install-process.md](local-install-process.md) |

OpenCode / xiaoO 在仓库根执行：

```bash
npx agent-insight install-ras
# 开发：node scripts/install-ras.js
# 检查：node scripts/install-ras.js --check
```

装完后新开一轮宿主对话（或重启 OpenCode / 确认 xiaoO IPC worker）再诱导异常。看板入口：Insight **AgentRAS 可靠性**；事件 `GET /api/ingest/ras-events`。

## 配置

运行时目录：`~/.agent-insight/ras/`（可用 `AGENT_INSIGHT_RAS_HOME` 覆盖）。推荐用安装器生成，避免手改本机路径。安装器在缺省时从 `agent_ras_config.default.yaml`（及 `detectors.catalog` 默认）合并 `detectors` / `recovery`，**不**覆盖已有阈值与 `service.*`。

| 资源 | 说明 |
|------|------|
| [`agent_ras/config/agent_ras_config.default.yaml`](../../../agent_ras/config/agent_ras_config.default.yaml) | 跨平台能力默认（`enabled` / `detectors` / `recovery`）；**新增检测域时改此文件** |
| [`agent_ras/config/agent_ras.inproc.example.json`](../../../agent_ras/config/agent_ras.inproc.example.json) | 同进程形状说明（`service.*` 占位路径；加域时不要改） |
| [`agent_ras/config/README.md`](../../../agent_ras/config/README.md) | 安装器与校验命令 |

openjiuwen / jiuwenclaw：宿主 `config.yaml` 中的 `agent_ras:` 段会校验为 `AgentRASConfig` 并透传工厂。字段与片段见 [platform-openjiuwen.md](platform-openjiuwen.md)。

### 常用开关

| 项 | 含义 |
|----|------|
| `enabled` | 总开关；`false` 不挂载 Rail / 不启用客户端 RAS |
| `detectors.*.enabled` | 单检测器开关 |
| `semantic_content_enabled` | L3 语义检测；默认 true（显式 `false` 才关） |
| `recovery.notify_user_on_warning` | LOW 是否可见 notice |

### Insight 期望配置（可选同步）

在前端 **AgentRAS 可靠性 → 可靠性能力**（`/agent-ras/fault-modes`）：

- **能力目录**：`GET /api/agent-ras/catalog`（由 `DETECTOR_PLUGIN.presentation` 自动发现，非 TS 硬编码）
- **平台配置**：`?view=configure` 按 catalog `configSchema` 动态渲染；`GET/PUT /api/agent-ras/config?platform=`

| 行为 | 说明 |
|------|------|
| 保存 | 写入用户级 `~/.agent-insight/data/ras-capability-configs/<user>.json` |
| 同步到客户端 | **OpenCode** / **xiaoO** 支持；开启后分别在插件启动 / hooker 会话开始时 `GET /api/ingest/ras-config?platform=...`，按 **内容指纹** 合并到本地 `config.json` 的 `platforms.<platform>`（并写入 `syncedFrom` 溯源；不覆盖 `service.*` / `insight.*`；两平台可并存不同阈值） |
| 导出 | YAML / JSON 复制，供 openjiuwen 等人工落盘 |
