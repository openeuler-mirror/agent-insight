# Host 交付锚点契约

> 各平台 HostControl 在 notice / steering 成功投递后，必须经 `action_result` 上报同形锚点，供 Insight 将 Session 交互重分类为 RAS。

## `trace_anchor`（检测点）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message_id` | string | 视宿主 | LLM/消息级 ID |
| `part_id` | string | 可选 | 消息 part ID |
| `call_id` | string | 工具异常时 | 工具调用 ID |
| `channel` | string | 推荐 | 如 `text` / `thinking` / `tool_call` |

由 observe 路径写入；anomaly / action_result 复用同一检测锚点。

## `delivery_anchor`（投递点）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message_id` | string | **是** | 投递进对话的消息 ID（不透明字符串） |
| `part_id` | string | 可选 | 对应 part |
| `channel` | string | 推荐 | `ras_notice` 或 `ras_steering` |

无 `message_id` 时 Insight **不**把对应交互标为 RAS（不做正文匹配）。

## 平台实现矩阵

| 平台 | trace_anchor | delivery_anchor | 备注 |
|------|--------------|-----------------|------|
| OpenCode | message/part/call | 预分配 messageID + prompt | 完整 |
| openjiuwen | 视 Monitor 采点 | Host 返回同形 dict（可合成） | Phase B |
| Hermes / OpenClaw | L3 填钩子时实现 | 同左 | 骨架 → Phase C |
