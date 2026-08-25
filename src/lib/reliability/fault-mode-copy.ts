type FaultModeCopy = {
  summary: string
  submodes?: Record<string, string>
}

const FAULT_MODE_COPY: Record<string, FaultModeCopy> = {
  'analysis-paralysis': {
    summary: 'Agent 在分析与方案比较中反复停留，迟迟不进入实际执行。',
    submodes: {
      '1': 'Agent 在多个方案间反复权衡和自我质疑，无法形成可执行结论。',
    },
  },
  'thinking-dead-loop': {
    summary: 'Agent 的思考过程重复或空转，任务持续没有有效进展。',
    submodes: {
      '1': 'Agent 持续重复相同思考内容，无法推进任务。',
      '2': 'Agent 反复产生语义相近的分析，但始终没有形成有效行动。',
      '3': 'Agent 在分析与计划之间循环切换，始终没有进入实质执行。',
    },
  },
  tool_repeat_dead_loop: {
    summary: 'Agent 反复调用相同、无效或相互切换的工具，执行无法收敛。',
    submodes: {
      '1': 'Agent 使用相同参数反复调用同一工具，未产生新的执行进展。',
      '2': 'Agent 在工具不可用或调用失败后仍持续重复调用。',
      '3': '重复工具调用达到全局限制后由保护机制中断执行。',
      '4': 'Agent 在两个工具之间反复切换，执行路径无法收敛。',
    },
  },
  'ras-early-stop': {
    summary: 'Agent 在完成全部必要步骤前提前结束任务。',
    submodes: {
      A: 'Agent 只完成部分阶段性结果便结束任务，必要产物未全部交付。',
    },
  },
  'step-omission': {
    summary: 'Agent 执行时遗漏计划中的必要步骤。',
    submodes: {
      '1': 'Agent 跳过计划中的必要步骤，但继续执行后续流程。',
    },
  },
  'step-order-error': {
    summary: 'Agent 未按计划的依赖顺序执行步骤。',
    submodes: {
      '1': 'Agent 颠倒存在前后依赖的执行步骤，导致流程顺序不符合计划。',
    },
  },
  'tool-selection-error': {
    summary: 'Agent 选择语义相近但功能不匹配的工具。',
  },
  'skill-selection-conflict': {
    summary: 'Agent 在候选 Skill 中选择了与任务目标不匹配的能力。',
    submodes: {
      '1': '语义相近的候选 Skill 干扰选择，使 Agent 使用了功能不匹配的能力。',
    },
  },
  'tool-argument-error': {
    summary: 'Agent 调用正确工具但传入了语义错误的参数。',
    submodes: {
      '1': '工具参数在保持结构合法的情况下被替换为错误目标。',
    },
  },
  'planning-logic-error': {
    summary: 'Agent 生成的计划存在依赖、完整性或约束冲突。',
    submodes: {
      '1': '计划中的前后依赖关系被颠倒，后置任务被错误地作为前置条件。',
      '2': '多个子任务互相依赖，形成无法开始或结束的依赖环。',
      '3': '计划缺少完成目标所必需的关键步骤。',
      '4': '计划同时包含互不兼容的约束，导致后续决策无法一致执行。',
    },
  },
  'unverified-success': {
    summary: 'Agent 未完成必要验证便报告任务成功。',
  },
  'execution-goal-drift': {
    summary: 'Agent 执行过程中逐渐偏离最初目标或上下文约束。',
    submodes: {
      '1': 'Agent 在阶段切换后未能保持目标与上下文连续，后续执行偏离原任务。',
    },
  },
  'memory-noise-interference': {
    summary: '无关、冲突或错误记忆干扰 Agent 的判断与执行。',
    submodes: {
      '1': '与当前任务无关的历史信息进入记忆，干扰 Agent 识别有效上下文。',
      '2': '记忆中同时存在相互冲突的事实，干扰 Agent 判断可信信息。',
      '3': '工具响应中混入似真但错误的信息，诱导 Agent 得出错误判断。',
      '4': '会话记忆中注入未经验证的先验，影响 Agent 的后续决策。',
    },
  },
  'memory-file-loss': {
    summary: 'Agent 依赖的持久记忆全部或部分丢失。',
    submodes: {
      '1': '持久记忆文件整体丢失，Agent 无法读取任何既有记忆。',
      '2': '持久记忆文件仍然存在，但关键约束信息已丢失。',
    },
  },
  'tool-observation-delta': {
    summary: '工具返回看似合理但偏离真实状态的结果，影响 Agent 后续决策。',
    submodes: {
      '1': '工具观测值被修改为看似合理的错误结果，诱导 Agent 基于错误事实行动。',
    },
  },
  'intermediate-conclusion-drift': {
    summary: '正确的中间结论在后续流程中被改写，导致最终决策偏离。',
    submodes: {
      '1': 'Agent 已形成的正确中间结论被错误信息覆盖，后续执行基于错误状态继续。',
    },
  },
  'compositional-implicit-intent': {
    summary: '多个独立正常的 Skill 组合后产生未声明的额外行为。',
    submodes: {
      '1': '多个 Skill 的组合执行使敏感信息跨越原有边界并进入非预期输出。',
    },
  },
}

export function faultModeSummary(faultId: string, fallback = ''): string {
  return FAULT_MODE_COPY[faultId]?.summary || fallback
}

export function faultSubmodeDescription(
  faultId: string,
  submodeId: string,
  fallback = '',
): string {
  return FAULT_MODE_COPY[faultId]?.submodes?.[submodeId] || fallback
}
