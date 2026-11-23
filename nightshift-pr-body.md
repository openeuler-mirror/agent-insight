## 问题

跨机部署（客户端与服务端不同机）时，Claude Code 的 `api_response_body` 只能通过 `body_ref` 指向客户端本机磁盘，服务端读不到，只能走 `assistant_response` + `tool_result` 兜底路径。原实现里没有可见文本的纯工具调用轮被直接丢弃：

- 该轮的 `tool_calls` 被一路攒到后面那条带最终回答的 assistant interaction 上，工具归属、`usage`、耗时全部错位；
- 界面对同一条记录固定按「Response → Tool calls」渲染，历史混合记录看起来就是「回答在前、工具在后」；
- Prompt 快照文本在 `content` 非空时直接返回，工具调用被吞掉。

Closes #426

## 修改

- **聚合器**：兜底路径中 `assistant_response` 文本为空时不再 `continue`，而是落一条 `content` 为空、按本轮 `api_request` 取 `usage`/`timeInfo` 的 assistant interaction。`tool_result` 先到（滞留在 pending）随后到（就近挂最后一条助手消息）都能落到自己那一轮，最终回答不再携带此前轮次的工具调用。始终没挂上任何工具调用的空壳在聚合结束前丢弃，不产生噪声条目。
- **边界不变**：`content` 非空的文本轮、带可读 `api_response_body` 的同机路径、子 agent / async Task 的轮次归属与补传逻辑均保持原行为。
- **Trace 详情 Output**：同一 interaction 同时有文本与工具调用时，按时间判断真实顺序（工具的 `timing.started_at` 早于本轮 `timeInfo.completed` 才视为先执行），先渲染 Tool calls 再渲染 Response；正常的「过渡语 + 工具」轮次仍是 Response 在前。
- **Prompt 快照**：`interactionToPromptText` 不再在 `content` 非空时丢弃工具调用，同一轮的文本与工具调用都会出现，顺序沿用同一时间判断。
- **单测**：aggregator 覆盖「纯工具轮（tool_result 先后两种到达顺序）」「文本 + 工具轮」「最终回答轮」；渲染层覆盖混合记录先工具后回答、正常轮次 Response 在前，以及 Prompt 快照文本与工具调用并存。

## 影响

- interactions 结构不变，只是条目划分变化：纯工具轮从「并入最终回答」变成独立一条。按 role 白名单取值的下游（评测、诊断、call-stats、Agent 调用树）读到的每一轮 `usage`/耗时反而更准确；以 `content` 非空为准取最终回答的路径（如 `final_result` 回退）不受空条目影响。
- 已入库的历史混合记录不重采、不改归属，只靠渲染兜底按真实顺序显示。

## 验证

- `node --import tsx --test test/claude-otel-ingest.test.ts test/trace-output-order.test.ts`：16/16 通过。
- `node --import tsx --test test/claude-context-e2e.test.ts test/claude-subagent-map-e2e.test.ts test/claude-trace-lifecycle.test.ts test/claude-context-supplement.test.ts test/otel-trace-aggregator.test.ts`：47/47 通过。
- `node --import tsx --test test/trace-ui-correctness.test.ts test/trace-content-modal.test.ts test/agent-trace-view-duration.test.ts`：17/17 通过。
- 全项目 `tsc --noEmit` 中与本次改动文件相关的错误为 0（其余报错为当前环境未生成的 Prisma Client 等既有问题）。
- 未启动 dev server，未在浏览器中验证。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
