# 能力目录与配置解耦（Insight UI catalog）

Insight「可靠性能力」目录与平台配置表单改为消费 `agent_ras` 插件元数据 + JSON Schema，新增故障域时除参数模板外不改共用前端/框架文件。

## 目标

- 前端不再硬编码子模式表与 detector 表单项。
- 新增域：只新增 `detectors|review|recovery/<domain>.py`（含 `presentation`）+ 改 [`agent_ras_config.default.yaml`](../../../agent_ras/config/agent_ras_config.default.yaml)。
- 能力模板与 `inproc.example` 职责分离：模板无 `service.*`；example 仅占位形状。

## 非目标

- 改 FI catalog；新 wire 动作；平台列表动态化。

## 触点（每加一域）

| 动作 | 路径 |
|------|------|
| 新增 | `detectors/<domain>.py`（`DETECTOR_PLUGIN` + `presentation` + `config_model`） |
| 新增（可选） | `review/`、`recovery/`、skills |
| **改（唯一共用）** | `agent_ras/config/agent_ras_config.default.yaml` |

禁止再改：`types`/`loader`（一次性除外）、`fault-mode-catalog.ts`、Panel 硬编码、`normalize` kind 表、`inproc.example`。Kind 文案走 catalog `kindLabels`。

## 双配置文件

| 文件 | 职责 |
|------|------|
| `agent_ras_config.default.yaml` | `enabled` / `detectors` / `recovery` 跨平台默认 |
| `agent_ras.inproc.example.json` | 含 `service` 占位；加域不改 |

## 契约

- `DetectorPlugin.presentation`：父级标签、子模式（含 `runtime_keys`）、detects/recovery 文案、prompt 键或内联模板。
- `GET /api/agent-ras/catalog`：domains + configSchema + configDefaults + 展平 submodes。
- 配置表单按 `configSchema` 动态渲染；PUT 按 catalog schema 校验（无 schema 则浅合并透传）。
- Insight 默认值解析 `agent_ras_config.default.yaml`；`presentation` 写在各 `detectors/<id>.py`，由 [`detectors/catalog.py`](../../../agent_ras/detectors/catalog.py) `build_capability_catalog` 组装（不再有独立 `agent_ras/catalog/` 包）。
- 旧 IF-N10 扁平键（`textLoop.*` / `toolRepeat.*`）只作 overrideDiff 别名，映射冻在 [`insight-legacy-flat-aliases.ts`](../../../src/lib/ingest/ras/insight-legacy-flat-aliases.ts)；新域不走这套别名。
- L3 skill 路径按 `skill_name` 解析：`detectors/skills/<name>/SKILL.md` 与 `review/skills/<name>/SKILL.md`。未知 skill 走通用 `{abnormal,confidence,rationale}` 解析；专用 parser 挂在对应 `DETECTOR_PLUGIN` / `REVIEW_PLUGIN.verdict_parser`。
- Kind 展示文案只来自 catalog `kindLabels`（`rasKindLabel` 无覆盖则显示 kind id）。

## 状态

已落地（catalog API + 哑 UI + `agent_ras_config.default.yaml` + install 合并）。
