import { safeUUID } from './safe-uuid';
import type {
  DatasetCaseRootCauseMeta,
  RootCauseItem,
} from './dataset-case-root-causes';

export type DatasetKind = 'ideal_output' | 'trajectory';

/** Case 来源；'user' = 用户手填，'skill-gen-draft' = skill 生成时自动起草。 */
export type DatasetCaseSource = 'user' | 'skill-gen-draft';

export interface DatasetCase {
  id: string;
  input: string;
  expectedOutput: string;
  evaluationFocus: string;
  tags: string[];
  trajectory: string;
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
  cases: DatasetCase[];
  createdAt: string;
  updatedAt: string;
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
    source,
  };
}
