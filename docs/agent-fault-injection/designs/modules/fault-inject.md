# 故障注入方式

| method | 机制 | 示例 |
|--------|------|------|
| `skill_inject` | 装 Skill + prompt | step-omission 等 |
| `file_tamper` | `fault_inject/injection` file ops（`apply_plan`） | memory-file-loss |
| `prompt_modify` | runtime `system.append`（`rewrite_engine`） | prompt-system-override |
| `tool_result_tamper` | runtime tool output 改写 | tool-result-corruption |
| `intercept_rewrite` | messages/assistant 改写 | interception-* |

分层：`fault_inject/injection/` 只做副作用（返回结构化结果 / 平台事件）；`fault_inject/catalog/` 的 `fault.json` 定义 plan；`apply_plan` / `runtime_env` 为薄胶水。展示元数据在 `SKILL.md` 的 `metadata`；method 中文名在 `capability_api.yaml`。见 [fault-mode-plugins.md](../features/fault-mode-plugins.md)。

`injectionEvidence` **已从 collect 协议移除**；服务端 Judge **只看轨迹 / 终答**。详见 [runtime-middleware-fault-injection.md](../runtime-middleware-fault-injection.md)。

## 扩展车道（防债）

封闭能力面清单：[`capability_api.yaml`](../../../../agent_fault_injection/fault_inject/catalog/capability_api.yaml)（method + structural/runtime op）。CI：`tests/unit/test_capability_api.py`。

| 车道 | 做什么 | 允许改动 |
|------|--------|----------|
| **A 加故障模式** | 日常产品扩展 | 仅 `fault_inject/skills/<id>/`（`SKILL.md` 含 `metadata` / 可选 `fault.json` / assets）。只引用能力清单内已有 method/op；**禁止**改 `rewrite_engine` / `file_ops` / 平台插件业务逻辑。**操作指南 →** [guides/lane-a-add-fault.md](../../guides/lane-a-add-fault.md) |
| **B 演进能力面** | 基础设施 | 更新 `capability_api.yaml`（含 method `label_zh`）+ L3 实现 + 对拍测试；再让故障模式调用 |
| **C 加平台** | 稀缺 | 实现 Adapter SPI；禁止复制 execute / rewrite |

**不做**：面向故障作者的「随意注册新 op」插件口；完整 Ports 六边形 / Method 类 Facade（L2 以清单 + CI 为准）。
