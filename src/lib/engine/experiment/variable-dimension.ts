// 变量维度策略：抽象「对比实验切换什么变量」，使配对/聚合/UI 与具体维度解耦。
// LLM 为首实现；framework/skill 为接口级 stub（无 UI，证明可扩展）。
// 新增维度仅实现 VariableDimension 接口；配对/UI 调接口不调具体类型（NFR-003/AC-020）。
import { prisma } from '@/lib/storage/prisma';

export type ExperimentType = 'single' | 'llm' | 'framework' | 'skill';

/**
 * 维度可读的 trace 字段子集。字段名对齐 prisma/schema.prisma 的 Execution 模型：
 * model / agentName / skill（非 skillName）/ skillVersion / query（非 input）/ framework / timestamp。
 */
export interface DimensionTrace {
  id?: string;
  taskId?: string | null;
  query?: string | null;
  model?: string | null;
  agentName?: string | null;
  skill?: string | null;
  skillVersion?: number | null;
  framework?: string | null;
  timestamp?: Date | string | null;
}

/** 候选 trace：queryCandidateTraces 返回的窄字段投影。 */
export interface TraceCandidate {
  id: string;
  taskId: string | null;
  query: string | null;
  model: string | null;
  agentName: string | null;
  skill: string | null;
  skillVersion: number | null;
  timestamp: Date;
}

/** 受控字段：除变量外，跨组必须一致的字段（用于判定可比性三条件之一）。 */
export interface ControlledField {
  field: 'agentName' | 'skill' | 'skillVersion' | 'model' | 'framework';
}

/**
 * 变量维度 Strategy 接口（IF-N04）。
 * - extractValue(trace): 取该维度的变量值（如 LLM 维度取 trace.model）
 * - controlledFields(): 变量之外须跨组一致的字段集
 * - queryCandidateTraces(agent, value): 按维度查候选 trace
 */
export interface VariableDimension {
  readonly dimension: ExperimentType;
  extractValue(trace: DimensionTrace): string;
  controlledFields(): ControlledField[];
  queryCandidateTraces(agent: string, value: string): Promise<TraceCandidate[]>;
}

function normalizeEmpty(v: string | null | undefined): string {
  return v ?? '';
}

/** LLM 维度：变量 = Execution.model；受控 = agentName + skill + skillVersion。 */
export const LLM_DIMENSION: VariableDimension = {
  dimension: 'llm',
  extractValue: (trace) => normalizeEmpty(trace.model),
  controlledFields: () => [
    { field: 'agentName' },
    { field: 'skill' },
    { field: 'skillVersion' },
  ],
  async queryCandidateTraces(agent, model): Promise<TraceCandidate[]> {
    const rows = await prisma.execution.findMany({
      where: { agentName: agent, model },
      select: {
        id: true,
        taskId: true,
        query: true,
        model: true,
        agentName: true,
        skill: true,
        skillVersion: true,
        timestamp: true,
      },
      orderBy: { timestamp: 'desc' },
    });
    return rows.map((r: {
      id: string; taskId: string | null; query: string | null; model: string | null;
      agentName: string | null; skill: string | null; skillVersion: number | null; timestamp: Date;
    }) => ({
      id: r.id,
      taskId: r.taskId,
      query: r.query,
      model: r.model,
      agentName: r.agentName,
      skill: r.skill,
      skillVersion: r.skillVersion,
      timestamp: r.timestamp,
    }));
  },
};

/**
 * Framework 维度 stub（NFR-003 接口级 stub，无 UI）。
 * 变量 = Execution.framework；受控 = agentName + skill + skillVersion + model（framework 变了，model 须一致）。
 * queryCandidateTraces 抛 NotImplemented——本期不接入 DB 查询。
 */
export const FRAMEWORK_DIMENSION: VariableDimension = {
  dimension: 'framework',
  extractValue: (trace) => normalizeEmpty(trace.framework),
  controlledFields: () => [
    { field: 'agentName' },
    { field: 'skill' },
    { field: 'skillVersion' },
    { field: 'model' },
  ],
  async queryCandidateTraces(): Promise<TraceCandidate[]> {
    throw new Error('NotImplemented: framework dimension queryCandidateTraces is a stub');
  },
};

/**
 * Skill 维度 stub（NFR-003 接口级 stub，无 UI）。
 * 变量 = Execution.skill（+ skillVersion）；受控 = agentName + model（skill 变了，model 须一致）。
 * queryCandidateTraces 抛 NotImplemented——本期不接入 DB 查询。
 */
export const SKILL_DIMENSION: VariableDimension = {
  dimension: 'skill',
  extractValue: (trace) => normalizeEmpty(trace.skill),
  controlledFields: () => [
    { field: 'agentName' },
    { field: 'model' },
  ],
  async queryCandidateTraces(): Promise<TraceCandidate[]> {
    throw new Error('NotImplemented: skill dimension queryCandidateTraces is a stub');
  },
};

const DIMENSION_REGISTRY: Partial<Record<ExperimentType, VariableDimension>> = {
  llm: LLM_DIMENSION,
  framework: FRAMEWORK_DIMENSION,
  skill: SKILL_DIMENSION,
};

/** 取维度实现。single → null（无对比维度）；未知 → null。 */
export function getDimension(type: ExperimentType | string): VariableDimension | null {
  return DIMENSION_REGISTRY[type as ExperimentType] ?? null;
}
