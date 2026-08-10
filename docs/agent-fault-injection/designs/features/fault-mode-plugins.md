# FI 故障模式自包含插件化

> 范围：仓根 `agent_fault_injection/fault_inject/`。  
> 目标：Lane A 新增故障模式只改 `skills/<id>/`；展示元数据落在 `SKILL.md` 的 `metadata`；注入能力封闭集（含中文名）只在 `capability_api.yaml`；删除 `fault-catalog.yaml`。  
> 状态：✅ 已落地 · 2026-08-10

---

## 一句话

| 项目 | 约定 |
|------|------|
| Per-fault 展示 | `SKILL.md` → `metadata` 扁平键（`label_zh` / `label_en` / `order` / `submodes`） |
| 注入能力 | `capability_api.yaml`（method ID + `label_zh` + ops） |
| 发现 | 扫 `skills/*/SKILL.md`（不变） |
| 新域触点 | 仅插件目录；零改全局 faults 表 |

## 目录

```text
fault_inject/
  skills/<id>/
    SKILL.md          # 必须：剧本 + metadata 展示键
    fault.json        # 可选：机械注入
  catalog/
    models.py
    skill_md.py       # frontmatter 唯一解析
    definition.py     # load/add + FaultRegistry
    presentation.py   # 从 metadata 组装 UI catalog
    scenarios.py
    capability_api.py / .yaml
```

## metadata 契约

```yaml
metadata:
  fault-category: …          # 既有
  label_zh: 中文名
  label_en: id-or-english
  order: 40                  # 越小越靠前；缺省殿后字典序
  submodes:                  # 可选；省略则解析正文「场景N」
    - name: …
      description: …
```

**禁止**：`visible` / `platforms` / 嵌套 `ui`（校验报错）。平台列表恒为框架默认双平台。

## 能力面

`injection_methods` 为 mapping（不再预留未实现的 `route_manipulate`）：

```yaml
injection_methods:
  skill_inject:
    label_zh: Skill 注入
  # …
```

扩 method/op = Lane B。

## 加载

`presentation.load_fault_ui_catalog()` 扫 skills + `skill_md` 读 metadata；method 标签来自 `capability_api.method_labels()`。

## Lane A

只改 `skills/<id>/`（+ 可选覆盖矩阵文档）。详见 [lane-a-add-fault.md](../../guides/lane-a-add-fault.md)。
