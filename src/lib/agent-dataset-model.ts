import { safeUUID } from './safe-uuid';
import type {
  DatasetCaseRootCauseMeta,
  RootCauseItem,
} from './dataset-case-root-causes';

export type DatasetKind = 'ideal_output' | 'trajectory';

/** Case 来源；'user' = 用户手填，'skill-gen-draft' = skill 生成时自动起草。 */
export type DatasetCaseSource = 'user' | 'skill-gen-draft' | 'trace-backflow';

export type DatasetFieldType = 'text' | 'number' | 'boolean' | 'json';
export type TraceBackflowArtifactSource = 'input' | 'output' | 'trace' | 'none';

export function defaultTraceBackflowSourceForField(key: string): TraceBackflowArtifactSource {
  switch (key.trim().toLocaleLowerCase()) {
    case 'input':
      return 'input';
    case 'output':
    case 'expected_output':
    case 'expectedoutput':
    case 'reference_output':
      return 'output';
    case 'trace':
    case 'trajectory':
      return 'trace';
    default:
      return 'none';
  }
}

export function sortTraceBackflowDatasetsByRecency<T extends { createdAt?: string; updatedAt?: string }>(
  datasets: readonly T[],
): T[] {
  return datasets
    .map((dataset, index) => ({ dataset, index }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.dataset.updatedAt || left.dataset.createdAt || '');
      const rightTime = Date.parse(right.dataset.updatedAt || right.dataset.createdAt || '');
      const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
      const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
      return normalizedRight - normalizedLeft || left.index - right.index;
    })
    .map(item => item.dataset);
}

export interface DatasetField {
  id: string;
  key: string;
  label: string;
  type: DatasetFieldType;
  description?: string;
  system?: boolean;
}

export function nextDatasetFieldKey(existingKeys: Iterable<string>): string {
  const used = new Set(existingKeys);
  let index = 1;
  while (used.has(`custom_field_${index}`)) index += 1;
  return `custom_field_${index}`;
}

export function parseDatasetNumberValue(value: unknown): number | '' {
  if (value === '' || value === null || value === undefined) return '';
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return '';
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error('invalid number');
  return parsed;
}

export interface DatasetCase {
  id: string;
  input: string;
  expectedOutput: string;
  evaluationFocus: string;
  tags: string[];
  trajectory: string;
  values?: Record<string, unknown>;
  traceSource?: {
    taskId: string;
    executionId?: string;
    capturedAt: string;
  };
  /** 默认 'user'；存量数据无此字段时按 'user' 兜底。 */
  source?: DatasetCaseSource;
  /** 隐藏缓存字段：预先从 expectedOutput 提取出的关键观点。 */
  rootCauses?: RootCauseItem[];
  /** 隐藏缓存元信息：用于判断缓存是否可复用。 */
  rootCauseMeta?: DatasetCaseRootCauseMeta;
}

export interface AgentDataset {
  id: string;
  name: string;
  description: string;
  targetAgent: string;
  /** 服务于哪个 skill；空字符串 = 通用 agent eval。 */
  targetSkill: string;
  tags: string[];
  datasetKind: DatasetKind;
  fields: DatasetField[];
  cases: DatasetCase[];
  createdAt: string;
  updatedAt: string;
}

export const EVALUATOR_CATALOG_FIELD_KEYS = ['available_tools', 'available_skills'] as const;
export type EvaluatorCatalogFieldKey = (typeof EVALUATOR_CATALOG_FIELD_KEYS)[number];

const EVALUATOR_CATALOG_FIELD_DEFINITIONS: Record<EvaluatorCatalogFieldKey, Omit<DatasetField, 'id' | 'label'>> = {
  available_tools: {
    key: 'available_tools',
    type: 'json',
    description: '任务执行时完整的可用 Tool 目录',
  },
  available_skills: {
    key: 'available_skills',
    type: 'json',
    description: '任务执行时完整的可用 Skill 目录',
  },
};

const EVALUATOR_CATALOG_FIELD_LABELS: Record<EvaluatorCatalogFieldKey, string> = {
  available_tools: '可用 Tool',
  available_skills: '可用 Skill',
};

export function evaluatorCatalogFieldKeyFromLabel(label: string): EvaluatorCatalogFieldKey | null {
  const normalized = label.trim().toLocaleLowerCase().replace(/[\s_-]/g, '');
  if (['availabletools', '可用tool', '可用工具'].includes(normalized)) return 'available_tools';
  if (['availableskills', '可用skill', '可用技能'].includes(normalized)) return 'available_skills';
  return null;
}

export function createEvaluatorCatalogField(
  key: EvaluatorCatalogFieldKey,
  label = EVALUATOR_CATALOG_FIELD_LABELS[key],
): DatasetField {
  return {
    id: key,
    ...EVALUATOR_CATALOG_FIELD_DEFINITIONS[key],
    label: label.trim() || EVALUATOR_CATALOG_FIELD_LABELS[key],
  };
}

export function defaultDatasetSchemaFields(kind: DatasetKind): DatasetField[] {
  const fields: DatasetField[] = [
    { id: 'input', key: 'input', label: '输入', type: 'text', system: true },
    { id: 'reference_output', key: 'reference_output', label: '预期输出', type: 'text', system: true },
  ];
  if (kind === 'trajectory') {
    fields.push({ id: 'trajectory', key: 'trajectory', label: '轨迹', type: 'json', system: true });
  }
  return fields;
}

export function withEvaluatorCatalogFields(
  fields: DatasetField[],
  cases: Iterable<Pick<DatasetCase, 'values'>>,
): DatasetField[] {
  const present = new Set<EvaluatorCatalogFieldKey>();
  for (const item of cases) {
    const values = item.values;
    if (!values) continue;
    for (const key of EVALUATOR_CATALOG_FIELD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(values, key)) present.add(key);
    }
  }
  const existing = new Set(fields.map(field => field.key));
  return [
    ...fields,
    ...EVALUATOR_CATALOG_FIELD_KEYS
      .filter(key => present.has(key) && !existing.has(key))
      .map(key => createEvaluatorCatalogField(key)),
  ];
}

export const TRAJECTORY_PLACEHOLDER = `{
  "id": "trace_id",
  "root_step": { }
}`;

export function schemaColumnTags(dataset: Pick<AgentDataset, 'datasetKind'>): string[] {
  return dataset.datasetKind === 'trajectory'
    ? ['input', 'reference_output', 'trajectory']
    : ['input', 'reference_output'];
}

/** 轨迹列占位示例（纯文本，可按需填写） */
export const DEFAULT_TRAJECTORY_JSON_SCHEMA = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "title": "Trajectory",
  "description": "Agent execution trajectory structure for evaluation",
  "properties": {
    "id": {
      "type": "string",
      "description": "trace_id"
    },
    "root_step": {
      "type": "object",
      "description": "根节点，记录整个轨迹的信息",
      "properties": {
        "id": {
          "type": "string"
        }
      }
    }
  }
}`;

export type DatasetColumnDataType = 'String' | '轨迹';

export interface DatasetDefaultFieldDef {
  key: string;
  dataType: DatasetColumnDataType;
  required: '否' | '是';
  description: string;
  /** 仅 trajectory 字段：展示数据结构 */
  dataStructureJson?: string;
}

/** 两种场景下的默认列配置 */
export function defaultFieldsForKind(kind: DatasetKind): DatasetDefaultFieldDef[] {
  const base: DatasetDefaultFieldDef[] = [
    {
      key: 'input',
      dataType: 'String',
      required: '否',
      description: '作为输入投递给评测对象',
    },
    {
      key: 'reference_output',
      dataType: 'String',
      required: '否',
      description: '预期理想输出，可作为评估时的参考标准',
    },
  ];
  if (kind === 'trajectory') {
    base.push({
      key: 'trajectory',
      dataType: '轨迹',
      required: '否',
      description: '作为 Agent 执行轨迹参考文本投递给评估器',
      dataStructureJson: undefined,
    });
  }
  return base;
}

export function createEmptyCase(source: DatasetCaseSource = 'user'): DatasetCase {
  return {
    id: safeUUID(),
    input: '',
    expectedOutput: '',
    evaluationFocus: '',
    tags: [],
    trajectory: '',
    values: {},
    source,
  };
}
