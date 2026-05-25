/**
 * 系统/内置 Agent 名称清单（纯数据,不依赖 Prisma,前后端都能 import）。
 *
 * 跟 src/lib/system-agents.ts 的 SYSTEM_AGENTS 数组**手工同步**:
 * 新加内置 agent 时同时更新这里(server side + client side 都要看见)。
 *
 * 用途:
 *   - 前端用例分析 trace 列表过滤掉这些 agent 的执行记录(它们是我们系统内部跑的,
 *     不是真实用户任务,展示给用户看会误导)
 *   - 任何其他需要区分"用户 trace vs 系统 trace"的场景
 */
export const SYSTEM_AGENT_NAMES: readonly string[] = [
  // 平台辅助功能 agent: 不是在"用 skill"业务,是在"维护 skill 元数据"。
  // 它们的 trace 出现在 case analysis 列表里会误导用户判断 skill 真实使用情况。
  'skill-generator-agent', // skill 生成对话(产 skill, 不消费 skill)
  'fault-diagnosis-agent', // 故障诊断对话(专用场景, 不是用户任务)
  'skill-optimizer-chat',  // skill 优化对话(改 skill, 不消费)

  // 评测器 agent: 它们的工作是评估别的 trace, 自己产的 trace 不是"对 skill 的真实调用"。
  'trace-quality-evaluator',  // 轨迹质量评估
  'task-completion-evaluator', // 任务完成度评估
  'skill-trigger-analyzer',    // 触发分析评测 ← 用户特别提到的"做触发分析时跑的用例"
  'completeness-checker',      // 评测 sub-agent
  'tool-choice-judge',         // 评测 sub-agent
  'attribution-locator',       // 评测 sub-agent
  'key-points-checker',        // 评测 sub-agent

  // 灰度测评 (A/B) 的 agent: A/B 数据量大(N rounds × M cases),让它在 case analysis
  // 列表也冒出来会冲淡真实 user trace。用户在专门的 A/B 测评页看这些数据,这里隔离。
  'grayscale-skill-agent',
  'grayscale-baseline-agent',

  // 注意: 'skill-debug-executor' **不**在这里 —— 它是 case analysis 的"从数据集"
  // 模式 + skill debug 页面共用的"真实跑 skill"执行器,产的 trace 是对 skill+version
  // 的真实执行结果, 应该出现在 case analysis 列表里, 用户能直接拿来分析。
];

/** Set 形式,前端 has() 查重用. */
export const SYSTEM_AGENT_NAME_SET = new Set<string>(SYSTEM_AGENT_NAMES);

/** trace 是不是系统内部任务产生的(非真实用户任务). */
export function isInternalSystemAgentTrace(agentName: string | null | undefined): boolean {
  if (!agentName) return false;
  return SYSTEM_AGENT_NAME_SET.has(agentName.trim());
}
