export interface AgentDebugFaultModeCopy {
  title: string;
  description: string;
}

export interface AgentDebugFaultMode {
  key: string;
  zh: AgentDebugFaultModeCopy;
  en: AgentDebugFaultModeCopy;
}

export const AGENT_DEBUG_FAULT_MODES: AgentDebugFaultMode[] = [
  {
    key: 'facts-and-context',
    zh: {
      title: '事实与上下文偏差',
      description: '使用了不存在、遗漏、过期或被过度压缩的信息，包括臆造文件内容。',
    },
    en: {
      title: 'Fact and context deviation',
      description: 'Uses missing, outdated, invented, or overly compressed information, including fabricated file content.',
    },
  },
  {
    key: 'constraints-and-goals',
    zh: {
      title: '约束与目标偏离',
      description: '遗漏用户或系统约束、选错处理目标，或实际行动偏离任务目标。',
    },
    en: {
      title: 'Constraint and goal deviation',
      description: 'Misses user or system constraints, targets the wrong object, or acts against the task goal.',
    },
  },
  {
    key: 'judgment-and-attribution',
    zh: {
      title: '判断与归因错误',
      description: '误判执行进度、错误解读工具结果、归错问题原因，或忽略重要警告。',
    },
    en: {
      title: 'Judgment and attribution errors',
      description: 'Misjudges progress, misreads tool results, attributes the wrong cause, or ignores important warnings.',
    },
  },
  {
    key: 'plan-execution-consistency',
    zh: {
      title: '计划与执行不一致',
      description: '计划不可执行、缺少明确计划、过度设计，或计划与实际行动不一致。',
    },
    en: {
      title: 'Plan and execution mismatch',
      description: 'Uses an infeasible, unclear, or over-engineered plan, or performs actions that diverge from the plan.',
    },
  },
  {
    key: 'tools-and-operations',
    zh: {
      title: '工具与操作错误',
      description: '工具选择、参数、格式、路径或编辑位置不正确，或执行了无效、危险的操作。',
    },
    en: {
      title: 'Tool and operation errors',
      description: 'Uses the wrong tool, parameters, format, path, or edit location, or performs an invalid or dangerous operation.',
    },
  },
  {
    key: 'verification-and-completion',
    zh: {
      title: '验证与完成度问题',
      description: '缺少必要验证、漏看测试失败，或在任务未完成、验证失败时宣称成功。',
    },
    en: {
      title: 'Verification and completion issues',
      description: 'Skips required verification, misses test failures, or claims success before the task is complete and verified.',
    },
  },
  {
    key: 'environment-and-platform',
    zh: {
      title: '环境与平台异常',
      description: '工具、网络、沙箱、依赖、认证权限或结构化输出环境出现异常。',
    },
    en: {
      title: 'Environment and platform failures',
      description: 'Encounters tool, network, sandbox, dependency, authentication, permission, or structured-output failures.',
    },
  },
  {
    key: 'resources-and-limits',
    zh: {
      title: '资源与时限问题',
      description: '执行步数、模型输出、上下文容量或单步耗时达到限制。',
    },
    en: {
      title: 'Resource and time limits',
      description: 'Reaches execution-step, model-output, context-capacity, or per-step time limits.',
    },
  },
  {
    key: 'repetition-and-non-convergence',
    zh: {
      title: '重复与不收敛',
      description: '重复调用或反复执行相似动作，长时间没有新进展，无法推进到终止条件。',
    },
    en: {
      title: 'Repetition and non-convergence',
      description: 'Repeats calls or similar actions without meaningful progress and fails to reach a stopping condition.',
    },
  },
];
