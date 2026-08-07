# 能力配置与可选同步（已落地）

Insight 前端按 `AgentRASConfig` 粒度维护多平台期望配置，并可按平台选择是否同步到客户端。

## 目标

- 在「故障模式」页内配置：总开关、detector 启停/阈值、recovery 开关。
- 每平台一份配置；`syncEnabled` 控制是否向客户端下发生效。
- OpenCode / xiaoO 客户端自动拉取合并；openjiuwen 导出 YAML。

## 非目标

- 子故障模式独立开关
- Prisma schema 变更
- openjiuwen 自动写宿主配置
- hermes/openclaw 能力配置（已从选择器移除）
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
type RasPlatformId = 'opencode' | 'openjiuwen' | 'xiaoo'
// platformSupportsSync: opencode | xiaoo

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

1. Insight 存期望配置（user × platform）。服务端 envelope 仍有 `revision` / `updatedAt`（UI / 审计 / PUT 乐观并发），**不作为客户端合并游标**。
2. 客户端拉取（fail-open）：
   - OpenCode 插件启动 → `GET .../ras-config?platform=opencode`
   - xiaoO hooker 会话开始（chat/tool，TTL 节流，**按 platform 分 stamp**）→ `?platform=xiaoo`
3. 合并条件（Insight 为源）：`syncEnabled` 且远端 `config` 存在，并且：
   - **能力字段内容指纹** 与本地该平台切片不一致 → 合并（`merged` / `content_drift`）
   - 指纹相同但本地仍有遗留 `ras_config_revision(s)` 或缺 `syncedFrom.contentHash` → 写盘迁移布局（`layout_migrate`），不改阈值
   - 指纹相同且布局已新 → `already_current`
4. 写入共享 `~/.agent-insight/ras/config.json`：
   - `agent_ras.platforms.<platform>` ← `enabled` / `detectors` / `recovery`
   - `agent_ras.platforms.<platform>.syncedFrom` ← `{ contentHash, revision?, updatedAt? }`（溯源元数据，**不参与下次比对决策**）
   - 合并时清除遗留的 `ras_config_revision` / `ras_config_revisions`（独立整数计数器已废弃）
   - 顶层 `detectors` / `recovery` 仅作 **最后一次 merge 的遗留镜像**；运行时读取优先 `platforms.<platform>`（OpenCode `loadThinkingConfig`、xiaoo `load_hello_config_from_ras_config`）。
5. 不覆盖 `service.*` / `insight.*`。xiaoo hello 仍强制 `semantic_content_enabled=false`。

可检测场景：远端内容变了（含 revision 未涨）→ 指纹变 → 合并；本地手工改了切片 → 指纹与远端不一致 → Insight 覆盖。

## 相关代码

- 校验/默认：`src/lib/ingest/ras/capability-config.ts`
- 持久化：`src/lib/ingest/ras/capability-config-store.ts`
- OpenCode 合并：`agent_ras/platform_adapter/opencode/config_sync.js`
- xiaoO 合并：`agent_ras/platform_adapter/xiaoo/config_sync.py`
