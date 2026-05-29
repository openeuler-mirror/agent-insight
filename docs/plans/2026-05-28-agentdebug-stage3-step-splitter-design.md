# AgentDebug 第三阶段：v0.6.1 Step Splitter 设计留档

## 背景

前两个阶段已经完成：

- UI 不再展示内部诊断 Step/Turn 编号，只展示左侧真实 trace 节点。
- 智能诊断 skill 输出协议要求 issue/root/cascade 携带 `anchorId`、`traceStepIndex`、`traceNodeLabel`、`traceNodeKind`。

这解决了用户理解和跳转问题，但后端当前仍是简化版 `DebugTurn` 构造：按 assistant/subagent/opencode 可见 turn 建记录，再把 tool call 锚点附上。它没有完整实现 v0.6.1 文档里的 FULL/LITE/SKIP、agentPath、tool result 回填、subAnchor 等规则。

第三阶段目标是补齐这个 splitter，让“认知分析单位”和“左侧真实节点”之间有明确、可审计的映射，而不是靠后续 normalize 兜底。

## 目标

1. 完整实现 v0.6.1 的 Step 定义：一个诊断 Step = 一条 assistant/subagent/opencode interaction，包含 reasoning/text、全部 tool_calls、对应 tool_results、可选 system error、关联的左侧 atomic nodes。
2. 保留用户侧唯一坐标：UI 和报告文案仍只展示左侧 trace 节点，不展示诊断 Step。
3. 为每个 Step 建立结构化映射：`diagnosticStep`、`sourceInteractionIndex`、`agentPath`、`anchorId`、`traceNodes[]`、`toolCalls[].anchorId/subAnchor`。
4. 支持一条 assistant 内多个 tool_call 的精确定位：Action/System 问题落到具体 tool 节点，Memory/Reflection/Planning 问题落到 assistant/LLM 节点。

## 非目标

- 不改变左侧执行链路的展示顺序。
- 不把 tool call 拆成独立诊断 Step。
- 不要求 UI 展示诊断 Step。
- 不在业务代码里新增诊断规则；错误判断仍放在 skill 和 agent 输出协议里。

## 数据结构建议

后端新增一个 splitter 输出结构，替代当前松散的 `DebugTurn` 组装：

```ts
interface DebugStep {
  diagnosticStep: number;
  sourceInteractionIndex: number;
  role: 'assistant' | 'subagent' | 'opencode';
  agentPath: string[];
  splitMode: 'FULL' | 'LITE' | 'SKIP';
  text: string;
  reasoningText?: string;
  anchorId?: string;
  traceStepIndex?: number;
  traceNodeLabel?: string;
  traceNodeKind?: string;
  traceNodes: Array<{
    anchorId: string;
    traceStepIndex: number;
    traceNodeLabel: string;
    traceNodeKind: string;
    subAnchor?: string;
  }>;
  toolCalls: DebugToolCall[];
  systemErrors: DebugSystemError[];
  memoryContext?: string;
}
```

`DebugToolCall` 继续保留当前字段，并补齐：

- `toolCallId`
- `resultInteractionIndex`
- `subAnchor`
- `resultAnchorId`
- `resultTraceStepIndex`

## Split Mode

`FULL`：正常 assistant/subagent/opencode turn，有可见文本、reasoning 或 tool calls，进入四模块拆分。

`LITE`：可作为上下文但不值得完整拆分，例如 compaction/synthetic summary。它只进入 Memory 上下文，不生成普通 Phase 1 单元格。

`SKIP`：user/system/tool result 等不单独形成诊断 Step，只作为触发输入或回填材料。

## Tool Result 回填

当前代码主要从 assistant interaction 自身的 tool_calls 取 output。第三阶段应建立 `toolCallId -> result` 表：

1. 扫描全部 interactions，收集 tool call id、local index、interaction index。
2. 扫描 tool/result 类型 interaction，按 `tool_call_id`、顺序邻近、interaction 边界回填。
3. 如果 assistant 内已有 output，以 assistant 内联 output 优先；外部 result 作为补充。
4. 每个 tool call 绑定自己的左侧 tool 节点和 result 节点，供 Action/System 归因使用。

## Agent Path

subagent 形成诊断 Step，但必须保留 `agentPath`：

- 根 agent：`["root"]` 或实际 agent name。
- 子 agent：`["root", "subagent:<type-or-name>"]`。
- 嵌套子 agent 继续追加。

`agentPath` 不直接显示给普通用户，但用于后续筛选、调试、跨 agent 归因。

## 左侧节点映射规则

- Step 主锚点优先取当前 assistant/LLM 节点。
- 没有 LLM 节点时，取 agent 节点。
- Action/System 问题优先使用具体 tool/skill/task 节点。
- 一条 assistant 有多个 tool call 时，每个 tool call 必须保留自己的 `anchorId` 和 `traceStepIndex`。
- 如果没有可用锚点，允许虚拟 Phase 0 错误，但要显式标记 `anchorResolution: "missing"`。

## UI 消费方式

UI 不展示 `diagnosticStep`。可展示的定位字段只有：

- `traceStepIndex`
- `traceNodeLabel`
- `traceNodeKind`
- `anchorId`

当需要调试时，可在开发态 JSON 或隐藏详情里查看 `diagnosticStep` 和 `sourceInteractionIndex`，但不要放进默认用户文案。

## 迁移步骤

1. 新增 splitter 模块和单元测试，覆盖 assistant 多工具、subagent、tool result 分离、compaction、无 assistant system error。
2. 让 `runAgentDebugDiagnosis` 使用 splitter 输出，保持现有 `turns` 输入 JSON 字段名兼容。
3. 更新 skill input 文档，把 `turns` 解释为 splitter 后的 `DebugStep[]`。
4. 增加对旧报告的兼容 normalize：缺少 trace 字段时仍从 `step` 兜底。
5. 增加 UI 回归用例：级联链路按钮跳到正确 tool 节点，而不是 assistant 节点。

## 风险

- 旧 trace 数据形态不统一，tool result 可能缺少稳定 `tool_call_id`，需要顺序邻近 fallback。
- agentPath 依赖 call tree 还原质量，遇到历史数据可能不完整。
- splitter 一旦改错，会影响所有智能诊断输入，所以必须先补测试再替换主路径。

## 验收标准

- 一条 assistant 内 3 个 tool call 只形成 1 个诊断 Step，但 3 个 tool call 各自有不同左侧节点锚点。
- UI 根因、级联链路、模块详情全部跳到对应左侧节点。
- 智能诊断 JSON 中 issue/root/cascade 都具备左侧 trace 定位字段。
- 文案中不出现“诊断 Step 2”“S2”这类用户不可理解编号。
