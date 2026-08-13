# 能力配置：目录解耦与多平台同步（已落地）

Insight「可靠性能力」目录与平台配置表单改为消费 `agent_ras` 插件元数据 + JSON Schema；按 `AgentRASConfig` 粒度维护多平台期望配置，并可按平台选择是否同步到客户端。新增故障域时除参数模板外不改共用前端/框架文件。

> 状态：已落地（catalog API + 哑 UI + `agent_ras_config.default.yaml` + install 合并 + 多平台同步）  
> 关联：[fault-domain-plugins.md](./fault-domain-plugins.md) §5（新增域触点）、[../modules/detectors.md](../modules/detectors.md)（catalog.py）、[../../guides/configuration.md](../../guides/configuration.md)（使用侧）

---

## 1. 目标 / 非目标

**目标**

- 前端不再硬编码子模式表与 detector 表单项；目录与表单由 `presentation` + `config_model` schema 自动发现。
- 在「故障模式」页内配置：总开关、detector 启停/阈值、recovery 开关。
- 每平台一份配置；`syncEnabled` 控制是否向客户端下发生效。
- OpenCode / xiaoO 客户端自动拉取合并；openjiuwen 导出 YAML。
- 新增域：只新增 `detectors|review|recovery/<domain>.py`（含 `presentation`）+ 改 [`agent_ras_config.default.yaml`](../../../agent_ras/config/agent_ras_config.default.yaml)。
- 能力模板与 `inproc.example` 职责分离：模板无 `service.*`；example 仅占位形状。

**非目标**

- 子故障模式独立开关。
- Prisma schema 变更。
- openjiuwen 自动写宿主配置。
- hermes/openclaw 能力配置（无 RAS 环内适配；观测仍走 OTel）。
- 新增侧栏导航项。
- 改 FI catalog；新 wire 动作；平台列表动态化。

---

## 2. 双配置文件

| 文件 | 职责 |
|------|------|
| [`agent_ras/config/agent_ras_config.default.yaml`](../../../agent_ras/config/agent_ras_config.default.yaml) | `enabled` / `detectors` / `recovery` 跨平台默认；**新增检测域时改此文件** |
| [`agent_ras/config/agent_ras.inproc.example.json`](../../../agent_ras/config/agent_ras.inproc.example.json) | 含 `service` 占位；加域不改 |

---

## 3. 新增域触点

| 动作 | 路径 |
|------|------|
| 新增 | `detectors/<domain>.py`（`DETECTOR_PLUGIN` + `presentation` + `config_model`） |
| 新增（可选） | `review/`、`recovery/`、`skills/<id>/SKILL.md` |
| **改（唯一共用）** | `agent_ras/config/agent_ras_config.default.yaml` 的 `detectors.<id>` |

禁止再改：`types`/`loader`（一次性除外）、`fault-mode-catalog.ts`、Panel 硬编码、`normalize` kind 表、`inproc.example`。Kind 文案走 catalog `kindLabels`。详见 [fault-domain-plugins.md §5](./fault-domain-plugins.md)。

---

## 4. catalog 契约

- `DetectorPlugin.presentation`：父级标签、子模式（含 `runtime_keys`）、detects/recovery 文案、prompt 键或内联模板。
- `GET /api/agent-ras/catalog`：返回 `domains` + `configSchema` + `configDefaults` + 展平 `submodes`。
- 配置表单按 `configSchema` 动态渲染；PUT 按 catalog schema 校验（无 schema 则浅合并透传）。
- Insight 默认值解析 `agent_ras_config.default.yaml`；`presentation` 写在各 `detectors/<id>.py`，由 [`detectors/catalog.py`](../../../agent_ras/detectors/catalog.py) `build_capability_catalog` 组装（不再有独立 `agent_ras/catalog/` 包）。
- 旧 IF-N10 扁平键（`textLoop.*` / `toolRepeat.*`）只作 overrideDiff 别名，映射冻在 [`insight-legacy-flat-aliases.ts`](../../../src/lib/ingest/ras/insight-legacy-flat-aliases.ts)；新域不走这套别名。
- L3 skill 路径按 `skill_name` 解析：`detectors/skills/<name>/SKILL.md` 与 `review/skills/<name>/SKILL.md`。未知 skill 走通用 `{abnormal,confidence,rationale}` 解析；专用 parser 挂在对应 `DETECTOR_PLUGIN` / `REVIEW_PLUGIN.verdict_parser`。
- Kind 展示文案只来自 catalog `kindLabels`（`rasKindLabel` 无覆盖则显示 kind id）。

---

## 5. 多平台配置与同步

### 5.1 入口 UX

路由：`/agent-ras/fault-modes`（不增侧栏）。深链：`?view=configure&detector=llm_thinking_loop`。

页内分段：

| 视图 | 职责 |
|------|------|
| 能力目录 | 现有子模式表（只读能力说明 + 本机改名） |
| 平台配置 | PlatformSelector + AgentRASConfig 表单 + 同步开关 + 导出 |

### 5.2 Envelope 契约

```ts
type RasCapabilityPlatformId = 'opencode' | 'openjiuwen' | 'xiaoo'
// platformSupportsSync: opencode | xiaoo

type RasCapabilityConfigEnvelope = {
  platform: RasCapabilityPlatformId
  syncEnabled: boolean
  revision: number
  updatedAt: string
  config: RasCapabilityConfigBody  // 对齐 core/config.py
  platformExtras?: Record<string, unknown>
}
```

存储：`~/.agent-insight/data/ras-capability-configs/<user>.json`，结构为 `{ platforms: Partial<Record<RasCapabilityPlatformId, RasCapabilityConfigEnvelope>> }`（user × platform map）。

### 5.3 API

| 端点 | 用途 |
|------|------|
| `GET/PUT /api/agent-ras/config?platform=` | 前端读写 |
| `GET /api/ingest/ras-config?platform=` | 客户端拉取；尊重 `syncEnabled` |

### 5.4 同步语义

1. Insight 存期望配置（user × platform）。服务端 envelope 仍有 `revision` / `updatedAt`（UI / 审计 / PUT 乐观并发），**不作为客户端合并游标**。
2. 客户端拉取（fail-open）：
   - OpenCode 插件启动（仅一次）→ `GET .../ras-config?platform=opencode`。loopback 走 `curl --noproxy`，硬上限 **connect 2s / total 3s**（`execFileSync` 再兜底 4s；curl 缺失则 fallback fetch 3s）；超时或看板不可达则跳过合并，**不阻塞** OpenCode 启动。
   - xiaoO hooker 会话开始（chat/tool，TTL 60s 节流，**按 platform 分 stamp 文件**）→ `?platform=xiaoo`（HTTP 超时 8s）。
3. 合并条件（Insight 为源）：`syncEnabled` 且远端 `config` 存在，并且：
   - **能力字段内容指纹** 与本地该平台切片不一致 → 合并（`content_drift`）
   - 指纹相同但本地仍有遗留 `ras_config_revision(s)` 或缺 `syncedFrom.contentHash` → 写盘迁移布局（`layout_migrate`），不改阈值
   - 指纹相同且布局已新 → `already_current`
4. 写入共享 `~/.agent-insight/ras/config.json`：
   - `agent_ras.platforms.<platform>` ← `enabled` / `detectors` / `recovery`
   - `agent_ras.platforms.<platform>.syncedFrom` ← `{ contentHash, revision?, updatedAt? }`（溯源元数据，**不参与下次比对决策**）
   - 合并时清除遗留的 `ras_config_revision` / `ras_config_revisions`（独立整数计数器已废弃），以及插件化之前写在 `agent_ras` 顶层的扁平域块（`llm_thinking_loop` / `repeat_tool`）。阈值只保留在 `platforms.<platform>.detectors`（顶层 `detectors` 仍是最后一次 merge 的镜像）。
   - 顶层 `detectors` / `recovery` 仅作 **最后一次 merge 的遗留镜像**；运行时读取优先 `platforms.<platform>`（OpenCode `loadCapabilityConfig`、xiaoo `load_hello_config_from_ras_config`）。切片透传**整份** `detectors`，不再构造域名白名单。
5. 不覆盖 `service.*` / `insight.*`。`semantic_content_enabled` 按配置透传到 hello（OpenCode / xiaoO 均支持 L3 Judge）；显式 `false` 才关。

可检测场景：远端内容变了（含 revision 未涨）→ 指纹变 → 合并；本地手工改了切片 → 指纹与远端不一致 → Insight 覆盖。

---

## 6. 相关代码

| 职责 | 文件 |
|------|------|
| catalog 组装 | [`agent_ras/detectors/catalog.py`](../../../agent_ras/detectors/catalog.py) |
| 校验 / 默认 | [`src/lib/ingest/ras/capability-config.ts`](../../../src/lib/ingest/ras/capability-config.ts) |
| 持久化 | [`src/lib/ingest/ras/capability-config-store.ts`](../../../src/lib/ingest/ras/capability-config-store.ts) |
| 旧扁平键别名 | [`src/lib/ingest/ras/insight-legacy-flat-aliases.ts`](../../../src/lib/ingest/ras/insight-legacy-flat-aliases.ts) |
| catalog API | [`src/app/api/agent-ras/catalog/route.ts`](../../../src/app/api/agent-ras/catalog/route.ts) |
| 配置读写 API | [`src/app/api/agent-ras/config/route.ts`](../../../src/app/api/agent-ras/config/route.ts) |
| OpenCode 合并 | [`agent_ras/platform_adapter/opencode/config_sync.js`](../../../agent_ras/platform_adapter/opencode/config_sync.js) |
| xiaoO 合并 | [`agent_ras/platform_adapter/xiaoo/config_sync.py`](../../../agent_ras/platform_adapter/xiaoo/config_sync.py) |

---

## 7. 状态

已落地（catalog API + 哑 UI + `agent_ras_config.default.yaml` + install 合并 + OpenCode/xiaoO 客户端拉取同步）。
