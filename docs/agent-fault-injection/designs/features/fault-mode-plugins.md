# FI 故障模式自包含插件化

> 范围：仓根 `agent_fault_injection/fault_inject/`。  
> 状态：✅ 已落地 · 2026-08-10  
> 本文同时是 **配方契约**：日常加故障只改 `skills/<id>/`，不另开操作指南。

---

## 1. 问题与目标

历史债：全局 `fault-catalog.yaml` 与 `skills/*/SKILL.md` 双份名单；UI 标签、平台过滤、子模式又散在 catalog Python / yaml。加一个故障要改引擎旁的表，和「扩注入原语」分不清。

目标：

| 项目 | 约定 |
|------|------|
| Per-fault 配方 | `skills/<id>/` 自包含：剧本 + 展示 + 可选机械注入 |
| 展示元数据 | `SKILL.md` frontmatter `metadata` 扁平键 |
| 注入能力 | 封闭集，只在 [`capability_api.yaml`](../../../../agent_fault_injection/fault_inject/catalog/capability_api.yaml) |
| 发现 | 扫 `skills/*/SKILL.md`；Insight 经 Python 拉列表，**不**硬编码故障 id |
| 新域触点 | 仅插件目录；零改全局 faults 表 |

非目标：面向故障作者的「随意注册新 op」插件口；完整 Ports 六边形 / Method 类 Facade；按故障在 Judge 里写分支。

---

## 2. 三层边界

```text
配方               skills/<id>/SKILL.md + 可选 fault.json / assets /
能力面             catalog/capability_api.yaml   method + structural/runtime op
引擎               injection/ · rewrite_engine · 平台 plugin/hooker
胶水               apply_plan / runtime_env；Insight 只合成 prompt + 拉 catalog
```

执行时 **plan 与副作用分离**：

| 层 | 做什么 | 不做什么 |
|----|--------|----------|
| `catalog/` | `fault.json` 声明 `injection.steps` / `injection.runtime` | 不改文件、不改写 LLM 数据面 |
| `injection/` | 只执行副作用：`file_ops` / rewrite；返回结构化结果或平台事件 | 不定义故障名单、不写 Judge 自证快照 |
| `apply_plan` / `runtime_env` | 薄胶水：steps → 已注册 op；runtime → `AGENT_FI_INJECTION_RUNTIME` | 不是第三套 plan 语言 |

- 配方**只引用**能力面已有 method/op，不得发明 `file.patch` 之类。
- 能力面演进必须带 L3 实现与对拍测试，再让配方调用。
- 平台差异（如 `assistant.tool_call.replace_argument` 仅 OpenCode）由 Adapter / 引擎承担；配方**不**声明 `platforms`。
- `injectionEvidence` 已从 collect 协议移除；Judge 只看轨迹 / 终答。

---

## 3. 改什么改哪里

| 变更 | 做什么 | 允许改动 | 禁止 |
|------|--------|----------|------|
| **加故障模式** | 日常产品扩展 | 仅 `fault_inject/skills/<id>/`（`SKILL.md` / 可选 `fault.json` / `assets/`）；可同步覆盖矩阵文档 | `rewrite_engine` / `file_ops` / 平台 plugin·hooker；Insight UI/API 硬编码名单；扩 `capability_api.yaml` |
| **演进能力面** | 基础设施 | `capability_api.yaml`（含 method `label_zh`）+ 引擎实现 + 对拍测试 | 借「加故障」的 PR 夹带新 op |
| **加被测平台** | 稀缺 | Adapter SPI | 复制 OpenCode/xiaoO 整段 `execute` / rewrite |

清单外的注入原语 → 停，先扩能力面再让配方引用。

当前封闭 op（加故障时不得扩展）：

```yaml
structural_ops:
  - file.write
  - file.delete
  - file.delete_section
  - file.truncate
  - file.replace_text
runtime_ops:
  - tool_result.replace_text
  - tool_result.replace_all
  - system.append
  - system.replace_text
  - messages.history.drop
  - messages.inject
  - assistant.replace_text
  - assistant.truncate
  - assistant.tool_call.replace_argument
```

`injection_methods` 为 mapping（不再预留未实现的 `route_manipulate`）。展示用中文标签来自 yaml，与真实 ops 可能并存——以 `fault.json` 为准。

| method | 机制 | 产品示例 |
|--------|------|----------|
| `skill_inject` | 装 Skill + prompt；可选附带 `injection.runtime` | `step-omission`；`planning-logic-error` S4（`system.append`）；`memory-noise-interference` S4（`messages.inject`） |
| `file_tamper` | `injection/` file ops（`apply_plan`） | `memory-file-loss` |
| `prompt_modify` | 顶层标签为 prompt 改写；**仅** `fault.json` 显式写才用此 method | 能力清单保留；产品多用 `skill_inject` + runtime |
| `tool_result_tamper` | runtime 改 tool output | `tool-observation-delta` |
| `intercept_rewrite` | runtime 改 messages / assistant / tool_call | `intermediate-conclusion-drift` / `skill-selection-conflict` |

---

## 4. 目录与身份

```text
fault_inject/
  skills/<id>/
    SKILL.md          # 必须：剧本 + metadata
    fault.json        # 可选：机械注入
    assets/           # 可选：file.write from_asset
    scripts/          # 可选：fault.json tools / verifier
  catalog/
    skill_md.py       # frontmatter 唯一解析
    definition.py     # load/add + FaultRegistry
    presentation.py   # 从 metadata 组装 UI catalog
    scenarios.py      # 正文「场景N」/ 总览表
    capability_api.py / .yaml
    models.py
```

| 字段 | 规则 | 例子 |
|------|------|------|
| 目录名 / `--fault` / `fault.json.name` | 三者**必须相同**；`^[a-z0-9]+(?:[-_][a-z0-9]+)*$` | `step-omission` |
| frontmatter `name` / `fault.json.skill_name` | 二者**必须相同**；Agent 看到的 skill 名，常带 `ras-` | `ras-step-omission` |

无 `fault.json` 时，加载器用目录名当 `name`、frontmatter `name` 当 `skill_name`。  
有 `SKILL.md` 的子目录即被 `FaultRegistry` 发现。`fault add` 只负责拷入 `SKILL.md` 并补 metadata；复杂 `fault.json` 仍手写。

---

## 5. `SKILL.md` 契约

frontmatter **必填** `name`、`description`。展示键写在 `metadata`（扁平，**禁止** `visible` / `platforms` / 嵌套 `ui`，校验报错）。

```yaml
metadata:
  fault-category: …          # 既有；无 fault.json 时作 category
  label_zh: 中文名           # 推荐；缺则用正文一级标题或 id
  label_en: id-or-english
  order: 40                  # 越小越靠前；缺省殿后字典序
  submodes:                  # 可选；省略则解析正文
    - name: …
      description: …
```

子模式解析顺序：`metadata.submodes` 优先；否则正文首张「首列为场景 id」的总览表，或 `## 场景N：名称` 标题。`submodes[].id` 可省略，则按同序正文场景或 `1`/`2`/… 补齐。

Insight 建任务合成用户 prompt（仅 TS [`compose-prompt.ts`](../../../../src/lib/fault-injection/compose-prompt.ts)，Python CLI 无镜像）：

```text
使用 <skill_name> 技能，执行<子模式名>。
```

Judge **只看轨迹 / 终答 vs Skill 规范**，不按故障名写分支；剧本须写清可观测产物。

最小模板：

````markdown
---
name: ras-your-fault
description: >-
  一句话说明故障意图与可观测特征（给发现/列表用）。
metadata:
  label_zh: 中文名
  label_en: your-fault-id
  order: 200
---

# 故障标题

加载本技能即表示必须执行下述流程。……

## 场景1：某某失败模式

**故障特征**：……

### 测试步骤
1. …

## 使用方式

```text
使用 ras-your-fault 技能，执行场景1
```
````

---

## 6. `fault.json` 契约

需要机械注入才加。选型：

| 效果 | `injection_method` | 需要 `fault.json`？ |
|------|--------------------|---------------------|
| Agent 按剧本故意做错 | `skill_inject` | 通常否 |
| 启动前改 workspace 文件 | `file_tamper` | 是，`injection.steps` |
| 运行时改 system / tool 结果 / messages / assistant | 已有 runtime op | 是，`injection.runtime` |

**显式 method 优先。** 未写时推断：

| plan | 推断 |
|------|------|
| 无 steps / runtime | `skill_inject` |
| 仅 `injection.steps` | `file_tamper` |
| 仅一类 runtime 前缀 | `tool_result.*` → `tool_result_tamper`；`system.*`/`user.*` → `prompt_modify`；`messages.*`/`assistant.*` → `intercept_rewrite` |
| 混合 runtime 前缀且未显式 method | 回退 `tool_result_tamper`（**不要依赖**；应显式写） |

Skill 文案 + runtime 的混合故障应标 **`skill_inject`**，runtime 放 `injection.runtime[]`（可 `when_submode`）。展示用 method 标签来自 yaml，与真实 ops 可能并存——以 `fault.json` 为准。

可选键：`tools` / `agent_tools`（`scripts/` 下文件名）、`authoritative_verifier`、`expose_skill_to_agent`。未知 op/method 由 `validate_fault_json_ops` / CI 拦住。

文件篡改示例（`when_submode` 对应子模式 id）：

```json
{
  "name": "memory-file-loss",
  "skill_name": "ras-memory-file-loss",
  "injection_method": "file_tamper",
  "injection": {
    "steps": [
      { "op": "file.write", "path": "MEMORY.md", "from_asset": "MEMORY.md" },
      { "op": "file.delete", "path": "MEMORY.md", "when_submode": "1" }
    ]
  }
}
```

运行时改写示例：

```json
{
  "name": "prompt-system-token",
  "skill_name": "ras-prompt-system-token",
  "injection_method": "prompt_modify",
  "injection": {
    "runtime": [
      { "op": "system.append", "args": { "text": "…冲突指令…" } }
    ]
  }
}
```

产品仿写：`memory-file-loss`（文件）、`planning-logic-error` S4（`system.append`）、`tool-observation-delta`（工具结果）、`memory-noise-interference` S4（`messages.inject`）、`skill-selection-conflict` / `tool-argument-error`（`assistant.tool_call.replace_argument`，OpenCode）。TOKEN 探针只在 `tests/fixtures/injection-smoke/`，不进产品 `skills/`。

---

## 7. 发现、加载与 Insight 列表

```text
FaultRegistry          扫 skills/*/SKILL.md → FaultDefinition（执行面）
load_fault_ui_catalog  同目录 metadata → 标签 / order / submodes（展示面）
Insight engine.ts      spawn Python 拼 JSON 列表；ordered_ids(order, 其余字典序)
平台列表               恒为框架默认双平台（opencode + xiaoo），忽略配方里的 platforms
```

`description`：有 frontmatter 则覆盖 `fault.json` 占位。两套加载必须都能过同一目录；缺 `SKILL.md` 即不存在。

---

## 8. 运行时串接

```text
SKILL.md 装到平台 skills/
composeFaultPrompt →「使用 <skill>，执行<场景>」
fault.json.steps → Agent 启动前改文件
fault.json.runtime → AGENT_FI_INJECTION_RUNTIME → plugin/hooker 改写
collect-result → Insight Judge（轨迹/终答；injectionEvidence 已从协议移除）
```

---

## 9. 新增故障模式的落地步骤

1. **选型**（§3 / §6）：纯剧本 / 文件 / 已有 runtime op。新 op → 先扩能力面。
2. **建目录** `fault_inject/skills/<id>/`，写 `SKILL.md`（§5）。可用：

```bash
python -m agent_fault_injection.cli fault add \
  --name your-fault-id \
  --skill-file /path/to/SKILL.md \
  --description "…" \
  --label-zh "中文名" \
  --order 200
```

3. 需要机械注入再加 `fault.json` / `assets/`（§6）。
4. 在覆盖矩阵加一行（目录名、skill_name、子模式、主题）。
5. 验证：

```bash
cd agent_fault_injection
python -m agent_fault_injection.cli fault list | grep your-fault-id
python -m pytest tests/unit/test_capability_api.py tests/unit/test_fault_registry.py -q
python -m pytest tests/unit/test_skill_submodes.py -q   # 若有多场景
```

Insight：Worker 在线 → 新建任务能选到该故障 → Run 详情看注入流程与轨迹。

---

## 10. 校验门禁

| 门 | 拦什么 |
|----|--------|
| `skill_md.read_frontmatter` | 无 YAML、缺 name/description、禁键 |
| `load_fault_definition` | 目录名 ≠ `name`；`skill_name` ≠ frontmatter `name` |
| `validate_fault_json_ops` / `test_capability_api` | 未知 method/op |
| `test_fault_registry` / `test_fault_ui_catalog` | 发现与展示装配 |

---

## 11. 常见坑与仿写

| 坑 | 正确做法 |
|----|----------|
| `fault.json.name` ≠ 目录名 | 二者必须一致 |
| `skill_name` ≠ frontmatter `name` | Agent 找不到 Skill |
| 新造清单外 op | 先扩能力面 + 实现，再写配方 |
| 只改 yaml、没建 `SKILL.md` | Registry 扫不到（且全局 faults 表已删） |
| 期望 RAS 检测表自动出现 | FI Skill 与 RAS 故障域 catalog 不同步 |
| 改 prompt 合成文案 | 改 Insight `compose-prompt.ts` |
| 混合 runtime 不写 method | 推断可能落到错误 method；显式写清 |

推荐仿写：

1. **纯剧本**：复制 `step-omission`。
2. **文件层**：复制 `memory-file-loss`。
3. **runtime 业务故事**：复制 `tool-observation-delta` / `intermediate-conclusion-drift` / `memory-noise-interference` S4。
4. **runtime TOKEN 探针**：复制 `tests/fixtures/injection-smoke/*-token`，勿放回产品 `skills/`。
5. **工具参数改写**：复制 `skill-selection-conflict` / `tool-argument-error`。
