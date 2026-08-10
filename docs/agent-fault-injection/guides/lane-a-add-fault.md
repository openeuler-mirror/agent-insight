# Lane A：新增故障模式（指导）

日常扩展故障模式走 **Lane A**：只加配方，不改注入引擎。设计边界见 [fault-inject.md](../designs/modules/fault-inject.md)「扩展车道」。

| 允许改动 | 禁止改动 |
|----------|----------|
| `agent_fault_injection/fault_inject/skills/<id>/`（`SKILL.md` 含 `metadata` 展示键、可选 `fault.json` / `assets/`） | `rewrite_engine` / `file_ops` / 平台 plugin·hooker |
| 同步 [fault-catalog.md](../designs/fault-catalog.md) 覆盖矩阵 | 在 [`capability_api.yaml`](../../../agent_fault_injection/fault_inject/catalog/capability_api.yaml) 增加新 op/method（那是 Lane B） |
| | 在 Insight UI/API 硬编码故障名单 |

插件化设计见 [fault-mode-plugins.md](../designs/features/fault-mode-plugins.md)。

需要清单外的注入原语 → 停，改走 **Lane B**。

---

## 0. 先选型

| 你要的效果 | 注入方式 | 需要 `fault.json`？ |
|------------|----------|---------------------|
| Agent 按剧本「故意做错」（跳步、死循环、选错工具…） | `skill_inject` | 通常否 |
| 启动前改 workspace 文件 | `file_tamper` | 是，`injection.steps` |
| 运行时改 system / tool 结果 / messages / assistant | 已有 runtime op | 是，`injection.runtime` |

当前可引用的 op（封闭集，Lane A 不得扩展）：

```yaml
# capability_api.yaml
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

---

## 1. 建目录与命名

```text
agent_fault_injection/fault_inject/skills/<fault-id>/
├── SKILL.md          # 必须
├── fault.json        # 可选（机械注入时）
└── assets/           # 可选（file.write from_asset）
```

| 字段 | 规则 | 例子 |
|------|------|------|
| 目录名 / `--fault` | 小写 kebab（或现有 snake） | `step-omission` |
| frontmatter `name` | Agent 看到的 skill 名，常带 `ras-` | `ras-step-omission` |
| `fault.json` 的 `name` | **必须 = 目录名** | `step-omission` |
| `fault.json` 的 `skill_name` | **必须 = frontmatter `name`** | `ras-step-omission` |

有 `SKILL.md` 的子目录会被 [`FaultRegistry`](../../../agent_fault_injection/fault_inject/catalog/definition.py) 自动发现；Insight 经 Python 列表拉取，无需改 TS 枚举。

---

## 2. 写 `SKILL.md`（所有 Lane A 都要）

最小模板：

````markdown
---
name: ras-your-fault
description: >-
  一句话说明故障意图与可观测特征（给发现/列表用）。
metadata:
  label_zh: 中文名
  label_en: your-fault-id
  order: 200                 # 越小越靠前；可省略
  # submodes:                # 可选；省略则解析正文「场景N」
  #   - name: 场景一名称
  #     description: 一句话
---

# 故障标题

加载本技能即表示必须执行下述流程。……

## 场景1：某某失败模式

**故障特征**：……

### 测试步骤
1. …
2. …

## 使用方式

```text
使用 ras-your-fault 技能，执行场景1
```
````

要点：

1. frontmatter **必填** `name`、`description`。
2. **推荐**在 `metadata` 写 `label_zh` / `label_en` / `order`（及可选 `submodes`）。**禁止**写 `visible` / `platforms` / 嵌套 `ui`。
3. 多子模式用 `## 场景N：名称`，或放一张首列为场景 id 的总览表；也可在 `metadata.submodes` 覆盖展示名（见 `fault_inject/catalog/scenarios.py` / `presentation.py`）。
4. 写清可观测产物/终答，方便 Judge 对照轨迹（不必改 Judge 代码）。
5. Insight 建任务时合成用户 prompt：`使用 <skill> 技能，执行<子模式名>。`（仅 TS：[`compose-prompt.ts`](../../../src/lib/fault-injection/compose-prompt.ts)）。

纯行为注入参考：[`skills/step-omission/SKILL.md`](../../../agent_fault_injection/fault_inject/skills/step-omission/SKILL.md)。

也可用脚手架装入 `SKILL.md`（复杂 `fault.json` 仍手写）：

```bash
python -m agent_fault_injection.cli fault add \
  --name your-fault-id \
  --skill-file /path/to/SKILL.md \
  --description "…" \
  --label-zh "中文名" \
  --order 200
```

---

## 3. 需要机械注入时再加 `fault.json`

### 3.1 文件篡改（`file_tamper`）

参考 [`memory-file-loss/fault.json`](../../../agent_fault_injection/fault_inject/skills/memory-file-loss/fault.json)：

```json
{
  "name": "memory-file-loss",
  "skill_name": "ras-memory-file-loss",
  "description": "文件层记忆丢失：播种 MEMORY.md 后删除全文或关键约束段。",
  "injection_method": "file_tamper",
  "injection": {
    "steps": [
      { "op": "file.write", "path": "MEMORY.md", "from_asset": "MEMORY.md" },
      { "op": "file.delete", "path": "MEMORY.md", "when_submode": "1" },
      {
        "op": "file.delete_section",
        "path": "MEMORY.md",
        "heading": "## 约束",
        "when_submode": "2"
      }
    ]
  }
}
```

配套：`assets/MEMORY.md`。`when_submode` 对应子模式 id（`"1"` / `"2"`）。

### 3.2 运行时改写

**System 追加** — 产品示例见 [`planning-logic-error`](../../../agent_fault_injection/fault_inject/skills/planning-logic-error/fault.json) S4；TOKEN 探针见 [`tests/fixtures/injection-smoke/prompt-system-token`](../../../agent_fault_injection/tests/fixtures/injection-smoke/prompt-system-token/fault.json)：

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

**工具结果篡改** — 产品示例 [`tool-observation-delta`](../../../agent_fault_injection/fault_inject/skills/tool-observation-delta/fault.json)；探针 [`tool-result-token`](../../../agent_fault_injection/tests/fixtures/injection-smoke/tool-result-token/fault.json)：先 `file.write`，再 `tool_result.replace_text`。

**历史注入** — 产品示例 [`memory-noise-interference`](../../../agent_fault_injection/fault_inject/skills/memory-noise-interference/fault.json) S4；探针 [`history-inject-token`](../../../agent_fault_injection/tests/fixtures/injection-smoke/history-inject-token/fault.json)：`messages.inject`。

**工具调用参数改写** — [`skill-selection-conflict`](../../../agent_fault_injection/fault_inject/skills/skill-selection-conflict/fault.json) / [`tool-argument-error`](../../../agent_fault_injection/fault_inject/skills/tool-argument-error/fault.json)：`assistant.tool_call.replace_argument`（OpenCode provider fetch 拦截；Lane B 已落地）。

规则：

- `injection_method` 可省略（由 steps/runtime 推断）；建议显式写清。
- op 必须在 `capability_api.yaml`；未知 op 会被 CI / `validate_fault_json_ops` 拦住。

---

## 4. UI 展示元数据（写在同一 `SKILL.md`）

展示字段已收敛到 frontmatter 的 `metadata`（见 §2），**不要**再改 `catalog/` 下任何全局故障表（`fault-catalog.yaml` 已删除）。

| 键 | 作用 |
|----|------|
| `label_zh` / `label_en` | 列表中文 / 英文名 |
| `order` | UI 排序（越小越靠前） |
| `submodes` | 可选；覆盖正文解析出的子模式展示 |

平台可见性由框架默认双平台（`opencode` + `xiaoo`），不在故障配方里声明。

---

## 5. 同步覆盖矩阵

在 [fault-catalog.md](../designs/fault-catalog.md) 表格加一行：目录名、skill_name、子模式、主题。

---

## 6. 验证清单

```bash
cd agent_fault_injection

# 1) 被发现
python -m agent_fault_injection.cli fault list | grep your-fault-id

# 2) capability / fault.json 未越权
python -m pytest tests/unit/test_capability_api.py tests/unit/test_fault_registry.py -q

# 3) 子模式解析（若有多场景）
python -m pytest tests/unit/test_skill_submodes.py -q

# 4) CLI 真跑（可选，需本机有平台）
python -m agent_fault_injection.cli run \
  --platform opencode --agent build \
  --fault your-fault-id --submode 1 \
  --prompt "执行场景1" \
  --workspace ~/.agent-insight/fault-injection/workspaces \
  --output-dir ~/.agent-insight/fault-injection/artifacts \
  --timeout-seconds 90
```

Insight 侧：Worker 在线 → 新建任务选到该故障 → Run 详情看注入流程与轨迹。最短启用见 [getting-started.md](getting-started.md)。

---

## 7. 运行时如何串起来（理解即可）

```text
SKILL.md 被装到平台 skills/
composeFaultPrompt →「使用 <skill>，执行<场景>」
fault.json.steps → Agent 启动前改文件
fault.json.runtime → AGENT_FI_INJECTION_RUNTIME → plugin/hooker 改写
Judge → 只看轨迹/终答 vs Skill 规范（不用按故障名写分支）
```

---

## 8. 常见坑

| 坑 | 正确做法 |
|----|----------|
| `fault.json.name` ≠ 目录名 | 二者必须一致 |
| `skill_name` ≠ frontmatter `name` | Agent 找不到 Skill |
| 新造 `file.patch` 之类 op | Lane B，先扩能力面 |
| 只改 yaml、没建 `SKILL.md` | Registry 扫不到 |
| 期望 RAS 检测表自动出现 | FI Skill 与 RAS `fault-mode-catalog` 不同步 |
| 改了 prompt 合成文案 | 改 Insight [`compose-prompt.ts`](../../../src/lib/fault-injection/compose-prompt.ts)（Python 侧已无镜像） |

---

## 9. 推荐仿写路径

1. **纯剧本**：复制 `step-omission` → 改场景与产物约定。
2. **文件层**：复制 `memory-file-loss` → 换 `assets/` + steps。
3. **runtime 业务故事**：复制 `tool-observation-delta` / `intermediate-conclusion-drift` / `memory-noise-interference` S4 → 换 op 参数与终答探针。
4. **runtime TOKEN 探针**：复制 `tests/fixtures/injection-smoke/*-token` → 仅用于注入链路冒烟，勿放回产品 `skills/`。
5. **工具参数改写**：复制 `skill-selection-conflict` / `tool-argument-error` → 换 `when`/`args`（依赖 `assistant.tool_call.replace_argument`）。
