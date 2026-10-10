# Injection smoke fixtures（机制冒烟，非产品故障）

这些目录保留原 TOKEN 探针配方，用于验证 OpenCode / xiaoO 中间件挂点
（`system.append` / `messages.inject` / `assistant.replace_text` / `tool_result.replace_text`）是否生效。

**不要**把本目录当作 `skills/` 故障类型；产品目录与 `fault list` 使用业务场景：

| Fixture | 对应业务故障 | 注入方式 |
|---------|--------------|----------|
| Smoke fixture | 产品故障（对照） | 注入方式 |
|---------------|------------------|----------|
| `history-inject-token` | `memory-noise-interference`@4 | `messages.inject`（父目录 skill_inject + S4 runtime） |
| `prompt-system-token` | `planning-logic-error`@4 | `system.append`（同上） |
| `tool-result-token` | `tool-observation-delta` | `tool_result_tamper` |
| `assistant-corruption-token` | `intermediate-conclusion-drift` | `intercept_rewrite` / `assistant.replace_text` |

用法：在单元/集成测试中用 `FaultRegistry(skills_root=...)` 指向本目录的某一子树，或直接加载其中的 `fault.json` runtime 计划；勿注册进默认 skills 根。
