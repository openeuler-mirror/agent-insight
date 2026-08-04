# 能力配置与可选同步（已落地）

Insight 前端按 `AgentRASConfig` 粒度维护多平台期望配置，并可按平台选择是否同步到客户端。

## 目标

- 在「故障模式」页内配置：总开关、detector 启停/阈值、recovery 开关。
- 每平台一份配置；`syncEnabled` 控制是否向客户端下发生效。
- 一期 OpenCode inproc 自动拉取合并；openjiuwen 导出 YAML；骨架平台禁用同步。

## 非目标

- 子故障模式独立开关
- Prisma schema 变更
- openjiuwen 自动写宿主 `config.yaml`
- hermes/openclaw 真实同步
- 新增侧栏导航项

## 入口 UX

路由：`/agent-ras/fault-modes`（不增侧栏）。

页内分段：

| 视图 | 职责 |
|------|------|
| 能力目录 | 现有子模式表（只读能力说明 + 本机改名） |
| 平台配置 | PlatformSelector + AgentRASConfig 表单 + 同步开关 + 导出 |

深链：`?view=configure&detector=llm_thinking_loop`。

## 契约

```ts
type RasPlatformId = 'opencode' | 'openjiuwen' | 'hermes' | 'openclaw'

interface RasCapabilityConfigEnvelope {
  platform: RasPlatformId
  syncEnabled: boolean
  revision: number
  updatedAt: string
  config: AgentRASConfigShape  // 对齐 core/config.py
  platformExtras?: Record<string, unknown>
}
```

存储：`~/.agent-insight/data/ras-capability-configs/<user>.json`（user × platform map）。

## API

| 端点 | 用途 |
|------|------|
| `GET/PUT /api/agent-ras/config?platform=` | 前端读写 |
| `GET /api/ingest/ras-config?platform=` | 客户端拉取；尊重 syncEnabled |

## 同步语义

1. Insight 存期望配置。
2. OpenCode 启动时（fail-open）`GET /api/ingest/ras-config?platform=opencode`。
3. 仅当 `syncEnabled && revision > localRevision` 合并 `config` 进本地 `config.json` 的逻辑字段（不覆盖 `service.*` python 路径）。
4. 写入 `agent_ras.ras_config_revision`；下次 `hello` 用新阈值。

## 相关代码

- 校验/默认：`src/lib/ingest/ras/capability-config.ts`
- 持久化：`src/lib/ingest/ras/capability-config-store.ts`
- OpenCode 合并：`agent_ras/platform_adapter/opencode/config_sync.js`
