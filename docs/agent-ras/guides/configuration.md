# 配置

## inproc（OpenCode / 同进程）

运行时配置目录：`~/.agent-insight/ras/`（可用 `AGENT_INSIGHT_RAS_HOME` 覆盖）。

| 资源 | 说明 |
|------|------|
| [`agent_ras/config/agent_ras_config.default.yaml`](../../../agent_ras/config/agent_ras_config.default.yaml) | 跨平台能力默认（`enabled` / `detectors` / `recovery`）；**新增检测域时改此文件** |
| [`agent_ras/config/agent_ras.inproc.example.json`](../../../agent_ras/config/agent_ras.inproc.example.json) | 同进程形状说明（`service.*` 占位路径；加域时不要改） |
| [`agent_ras/config/README.md`](../../../agent_ras/config/README.md) | 安装器与校验命令 |

推荐用安装器生成配置，避免手改本机路径：

```bash
npx agent-insight install-ras
# 或仓库内：node scripts/install-ras.js
```

安装器在缺省时从 `agent_ras_config.default.yaml`（及 `detectors.catalog` 默认）合并 `detectors` / `recovery`，**不**覆盖已有阈值与 `service.*`。

## openjiuwen / jiuwenclaw

宿主 `config.yaml` 中的 `agent_ras:` 段会校验为 `AgentRASConfig` 并透传工厂。字段说明与片段见 [platform-openjiuwen.md](platform-openjiuwen.md)。

## 常用开关

| 项 | 含义 |
|----|------|
| `enabled` | 总开关；`false` 不挂载 Rail |
| `detectors.*.enabled` | 单检测器开关 |
| `semantic_content_enabled` | L3 语义检测；默认 true |
| `recovery.notify_user_on_warning` | LOW 是否可见 notice |

## Insight 期望配置（可选同步）

在前端 **AgentRAS 可靠性 → 可靠性能力**（`/agent-ras/fault-modes`）：

- **能力目录**：`GET /api/agent-ras/catalog`（由 `DETECTOR_PLUGIN.presentation` 自动发现，非 TS 硬编码）
- **平台配置**：`?view=configure` 按 catalog `configSchema` 动态渲染；`GET/PUT /api/agent-ras/config?platform=`

| 行为 | 说明 |
|------|------|
| 保存 | 写入用户级 `~/.agent-insight/data/ras-capability-configs/<user>.json` |
| 同步到客户端 | **OpenCode** / **xiaoO** 支持；开启后分别在插件启动 / hooker 会话开始时 `GET /api/ingest/ras-config?platform=...`，按 **内容指纹** 合并到本地 `config.json` 的 `platforms.<platform>`（并写入 `syncedFrom` 溯源；不覆盖 `service.*` / `insight.*`；两平台可并存不同阈值） |
| 导出 | YAML / JSON 复制，供 openjiuwen 等人工落盘 |

新增故障域 checklist：见 [fault-domain-plugins.md §5.1](../designs/features/fault-domain-plugins.md) 与 [capability-catalog-decouple.md](../designs/features/capability-catalog-decouple.md)。

设计见 [capability-config-sync.md](../designs/features/capability-config-sync.md)。
