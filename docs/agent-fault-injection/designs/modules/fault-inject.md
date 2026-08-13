# 故障注入方式

| method | 机制 | 示例 |
|--------|------|------|
| `skill_inject` | 装 Skill + prompt；可选附带 `injection.runtime` | step-omission；**planning-logic-error**（S4 附 `system.append`）；**memory-noise-interference**（S4 附 `messages.inject`）；compositional-implicit-intent 等 |
| `file_tamper` | `fault_inject/injection` file ops（`apply_plan`） | memory-file-loss |
| `prompt_modify` | 顶层 method 为 prompt 改写（仅当 `fault.json` **显式**写 `injection_method: prompt_modify`） | 能力清单保留；产品 skill 多用 `skill_inject` + runtime |
| `tool_result_tamper` | runtime tool output 改写 | tool-observation-delta |
| `intercept_rewrite` | messages/assistant/tool_call 改写 | intermediate-conclusion-drift / skill-selection-conflict |

**显式 method 优先**：`fault.json` 写了 `injection_method` 则以其为准；**未写**时才按 plan 推断。混合故障（Skill 文案 + runtime op）应标 **`skill_inject`**，runtime 写在 `injection.runtime[]`（可带 `when_submode`）。展示用 method 标签来自 `capability_api.yaml`，与真实 ops 可能并存——以 `fault.json` 为准。

分层：`fault_inject/injection/` 只做副作用（返回结构化结果 / 平台事件）；`fault_inject/catalog/` 的 `fault.json` 定义 plan；`apply_plan` / `runtime_env` 为薄胶水。展示元数据在 `SKILL.md` 的 `metadata`；method 中文名在 `capability_api.yaml`。

`injectionEvidence` **已从 collect 协议移除**；服务端 Judge **只看轨迹 / 终答**。

## 扩展车道（防债）

封闭能力面清单：[`capability_api.yaml`](../../../../agent_fault_injection/fault_inject/catalog/capability_api.yaml)（method + structural/runtime op）。CI：`tests/unit/test_capability_api.py`。

| 车道 | 做什么 | 允许改动 |
|------|--------|----------|
| **A 加故障模式** | 日常产品扩展 | 仅 `fault_inject/skills/<id>/`（`SKILL.md` 含 `metadata` / 可选 `fault.json` / assets）。只引用能力清单内已有 method/op；**禁止**改 `rewrite_engine` / `file_ops` / 平台插件业务逻辑。 |
| **B 演进能力面** | 基础设施 | 更新 `capability_api.yaml`（含 method `label_zh`）+ L3 实现 + 对拍测试；再让故障模式调用 |
| **C 加平台** | 稀缺 | 实现 Adapter SPI；禁止复制 execute / rewrite |

**不做**：面向故障作者的「随意注册新 op」插件口；完整 Ports 六边形 / Method 类 Facade（L2 以清单 + CI 为准）。
