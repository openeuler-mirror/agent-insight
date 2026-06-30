import type { FilterColumn } from './types';

/**
 * 链路追踪(Execution)列注册表 —— 对标 langfuse 的 `FIELDS`。
 *
 * 单一事实源:前端据此渲染「选列 → 选操作符 → 值控件」,后端 buildPrismaWhere 据此
 * 校验 + 翻译。加一种过滤 = 在这里注册一列(而非前后端各改一处)。
 *
 * 字段名与 prisma/schema.prisma 的 Execution 模型对齐(见 §3.4)。
 */
export const TRACE_FILTER_COLUMNS: readonly FilterColumn[] = [
  // —— 文本(可模糊;syncMode=textSearch 裸值=contains)——
  { column: 'query', type: 'string', label: '查询内容', syncMode: 'textSearch', nullable: true },
  { column: 'finalResult', type: 'string', label: '输出内容', syncMode: 'textSearch', nullable: true },
  { column: 'agentName', type: 'string', label: 'Agent 名', syncMode: 'textSearch', nullable: true },
  { column: 'subagentName', type: 'string', label: '子 Agent 名', syncMode: 'textSearch', nullable: true },
  { column: 'model', type: 'string', label: '模型', syncMode: 'textSearch', nullable: true },
  { column: 'label', type: 'string', label: '标注', syncMode: 'textSearch', nullable: true },

  // —— 枚举(精确多选;syncMode=exactOption)——
  { column: 'framework', type: 'stringOptions', label: '框架', syncMode: 'exactOption', nullable: true },
  { column: 'subagentType', type: 'stringOptions', label: '子 Agent 类型', syncMode: 'exactOption', nullable: true },

  // —— 数值(可区间)——
  { column: 'latency', type: 'number', label: '耗时', unit: 'ms', nullable: true },
  { column: 'tokens', type: 'number', label: 'Tokens', nullable: true },
  { column: 'inputTokens', type: 'number', label: '输入 Tokens', nullable: true },
  { column: 'outputTokens', type: 'number', label: '输出 Tokens', nullable: true },
  { column: 'cost', type: 'number', label: '成本', unit: '$', nullable: true },
  { column: 'toolCallCount', type: 'number', label: '工具调用数', nullable: true },
  { column: 'toolCallErrorCount', type: 'number', label: '工具错误数', nullable: true },
  { column: 'answerScore', type: 'number', label: '答案分', nullable: true },
  { column: 'skillScore', type: 'number', label: 'Skill 分', nullable: true },
  { column: 'skillTriggerRate', type: 'number', label: 'Skill 触发率', nullable: true },

  // —— 时间(可区间)——
  { column: 'timestamp', type: 'datetime', label: '时间' },

  // —— 布尔 ——
  { column: 'isAnswerCorrect', type: 'boolean', label: '答案正确', nullable: true },
  { column: 'isSkillCorrect', type: 'boolean', label: 'Skill 正确', nullable: true },
  { column: 'isSubagent', type: 'boolean', label: '是子 Agent' },

  // —— 数组/多选 ——
  // agents:observedAgents JSON 子串降级下推(对称 ExecutionSkill 反查表见后续 Phase)。
  {
    column: 'agents',
    type: 'arrayOptions',
    label: 'Agent(多选)',
    field: 'observedAgents',
    source: 'observedAgents',
    syncMode: 'arrayOption',
  },
  // skill:经 ExecutionSkill 反查表(异步),buildPrismaWhere defer 给调用方。
  { column: 'skill', type: 'arrayOptions', label: 'Skill', source: 'executionSkill', syncMode: 'arrayOption' },

  // —— 计算列(非真实列,defer;前端二次过滤或后续 denorm)——
  { column: 'status', type: 'stringOptions', label: '状态', source: 'computed', syncMode: 'exactOption' },
  { column: 'ownership', type: 'stringOptions', label: '归属', source: 'computed', syncMode: 'exactOption' },
] as const;

const BY_COLUMN = new Map<string, FilterColumn>(TRACE_FILTER_COLUMNS.map((c) => [c.column, c]));

export function resolveTraceColumn(column: string): FilterColumn | undefined {
  return BY_COLUMN.get(column);
}
