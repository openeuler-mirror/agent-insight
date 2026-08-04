# 配置

## inproc（OpenCode / 同进程）

运行时配置目录：`~/.agent-insight/ras/`（可用 `AGENT_INSIGHT_RAS_HOME` 覆盖）。

| 资源 | 说明 |
|------|------|
| [`agent_ras/config/agent_ras.inproc.example.json`](../../../agent_ras/config/agent_ras.inproc.example.json) | 同进程示例（`transport: inproc`） |
| [`agent_ras/config/README.md`](../../../agent_ras/config/README.md) | 安装器与校验命令 |

推荐用安装器生成配置，避免手改路径：

```bash
npx agent-insight install-ras
# 或仓库内：node scripts/install-ras.js
```

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

在前端 **AgentRAS 可靠性 → 可靠性能力 → 平台配置**（`/agent-ras/fault-modes?view=configure`）可按平台维护与 `AgentRASConfig` 对齐的期望配置。

| 行为 | 说明 |
|------|------|
| 保存 | 写入用户级 `~/.agent-insight/data/ras-capability-configs/<user>.json` |
| 同步到客户端 | 仅 **OpenCode** 一期支持；开启后插件启动时 `GET /api/ingest/ras-config?platform=opencode`，按 `revision` 合并逻辑字段到本地 `config.json`（不覆盖 `service.*` 路径） |
| 导出 | YAML / JSON 复制，供 openjiuwen 等人工落盘 |

设计见 [capability-config-sync.md](../designs/features/capability-config-sync.md)。
