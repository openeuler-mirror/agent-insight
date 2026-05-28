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

/**
 * "用例分析-从 Trace" 模式应该隐藏哪些 agent 的 trace?
 *
 * 跟 isInternalSystemAgentTrace 区别: 这个排除集合**不含** grayscale-* (A/B 灰度),
 * 让 A/B 跑过的 trace 也能在用例分析里看到 (用户可以复用 A/B 的 trace 跑评测)。
 * 真正要隐藏的: 平台辅助 + 各评测器 (它们的 trace 跟"用例分析"语义无关)。
 *
 * 调用方需要进一步加来源徽章 (A/B / 用例分析 / 真实), 帮用户区分。
 */
const HIDDEN_FROM_CASE_ANALYSIS = new Set<string>([
  'skill-generator-agent',
  'fault-diagnosis-agent',
  'skill-optimizer-chat',
  'trace-quality-evaluator',
  'task-completion-evaluator',
  'skill-trigger-analyzer',
]);

export function shouldHideFromCaseAnalysis(agentName: string | null | undefined): boolean {
  if (!agentName) return false;
  return HIDDEN_FROM_CASE_ANALYSIS.has(agentName.trim());
}

/**
 * 根据 trace agentName 推 trace 来源标签 (给用例分析"从 Trace"行徽章用)。
 *   - 'ab': A/B 灰度对照 (grayscale-skill-agent / grayscale-baseline-agent)
 *   - 'batch': 用例分析"从数据集"的执行器 (skill-debug-executor / batch-eval-agent)
 *   - 'real': 用户真实调用 (其他所有非系统 agent)
 *   - 'system': 平台辅助 / 评测器 (HIDDEN_FROM_CASE_ANALYSIS 命中, 实际不会展示, 兜底)
 */
export type TraceSource = 'ab' | 'batch' | 'real' | 'system';
export function classifyTraceSource(agentName: string | null | undefined): TraceSource {
  if (!agentName) return 'real';
  const a = agentName.trim();
  if (a === 'grayscale-skill-agent' || a === 'grayscale-baseline-agent') return 'ab';
  if (a === 'skill-debug-executor' || a === 'batch-eval-agent') return 'batch';
  if (HIDDEN_FROM_CASE_ANALYSIS.has(a)) return 'system';
  return 'real';
}
