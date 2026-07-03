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
  { column: 'query', type: 'string', label: '查询内容', description: '用户输入 / 问题', syncMode: 'textSearch', nullable: true },
  { column: 'finalResult', type: 'string', label: '输出内容', description: 'trace 最终输出', syncMode: 'textSearch', nullable: true },
  { column: 'agentName', type: 'string', label: 'Agent 名', description: '主 Agent 名称', syncMode: 'textSearch', nullable: true },
  { column: 'subagentName', type: 'string', label: '子 Agent 名', description: '子 Agent 显示名', syncMode: 'textSearch', nullable: true },
  { column: 'model', type: 'string', label: '模型', description: 'LLM 模型名', syncMode: 'textSearch', nullable: true },
  { column: 'label', type: 'string', label: '标注', description: '人工标注', syncMode: 'textSearch', nullable: true },

  // —— 枚举(精确多选;syncMode=exactOption)——
  { column: 'framework', type: 'stringOptions', label: '框架', description: '采集框架 / 平台', syncMode: 'exactOption', nullable: true },
  { column: 'subagentType', type: 'stringOptions', label: '子 Agent 类型', description: 'kuafu / general …', syncMode: 'exactOption', nullable: true },

  // —— 数值(可区间)——
  // ⚠️ latency 单位=**秒**:DB 原始列即秒(claude=durationMs/1000、jiuwen=ns/1e9)。
  //    过滤值与原始列同单位,直接比较;不要标 ms(展示侧 toDisplayLatencyMs 的 ms 是另一套换算)。
  { column: 'latency', type: 'number', label: '耗时', description: '执行时长(秒)', unit: 's', nullable: true },
  { column: 'tokens', type: 'number', label: 'Tokens', description: '总 token 数', nullable: true },
  { column: 'inputTokens', type: 'number', label: '输入 Tokens', description: '输入 token 数', nullable: true },
  { column: 'outputTokens', type: 'number', label: '输出 Tokens', description: '输出 token 数', nullable: true },
  { column: 'cost', type: 'number', label: '成本', description: '估算成本($)', unit: '$', nullable: true },
  { column: 'toolCallCount', type: 'number', label: '工具调用数', description: '工具调用次数', nullable: true },
  { column: 'toolCallErrorCount', type: 'number', label: '工具错误数', description: '工具调用失败次数', nullable: true },
  // ⚠️ 分数列存 0–1(非 0–100),过滤值按 0–1 输入。
  { column: 'answerScore', type: 'number', label: '答案分', description: '答案得分(0–1)', nullable: true },
  { column: 'skillScore', type: 'number', label: 'Skill 分', description: 'Skill 得分(0–1)', nullable: true },
  { column: 'skillTriggerRate', type: 'number', label: 'Skill 触发率', description: '触发率(0–1)', nullable: true },

  // —— 时间(可区间)——
  { column: 'timestamp', type: 'datetime', label: '时间', description: 'trace 起始时间' },

  // —— 布尔 ——
  { column: 'isAnswerCorrect', type: 'boolean', label: '答案正确', description: '评测:答案是否正确', nullable: true },
  { column: 'isSubagent', type: 'boolean', label: '是子 Agent', description: '是否子 Agent 执行' },

  // —— 数组/多选 ——
  // agents:observedAgents JSON 子串降级下推(对称 ExecutionSkill 反查表见后续 Phase)。
  {
    column: 'agents',
    type: 'arrayOptions',
    label: 'Agent(多选)',
    description: 'trace 涉及的 agent',
    field: 'observedAgents',
    source: 'observedAgents',
    syncMode: 'arrayOption',
    nullable: true, // observedAgents 可空 → none of 要包含空值行
  },
  // skill:经 ExecutionSkill 反查表(异步),buildPrismaWhere defer 给调用方。
  { column: 'skill', type: 'arrayOptions', label: 'Skill', description: '调用的 skill', source: 'executionSkill', syncMode: 'arrayOption' },

  // —— 计算列(非真实列,defer;前端二次过滤或后续 denorm)——
  { column: 'status', type: 'stringOptions', label: '状态', description: 'running / success / failed', source: 'computed', syncMode: 'exactOption' },
  { column: 'ownership', type: 'stringOptions', label: '归属', description: 'user / system', source: 'computed', syncMode: 'exactOption' },
] as const;

const BY_COLUMN = new Map<string, FilterColumn>(TRACE_FILTER_COLUMNS.map((c) => [c.column, c]));

export function resolveTraceColumn(column: string): FilterColumn | undefined {
  return BY_COLUMN.get(column);
}
