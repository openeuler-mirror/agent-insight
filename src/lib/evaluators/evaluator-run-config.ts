export const EXACT_MATCH_EVALUATOR_ID = 'preset-text-exact-match' as const;
export const ENTITY_F1_EVALUATOR_ID = 'preset-text-entity-f1' as const;

export const CONFIGURABLE_TEXT_EVALUATOR_IDS = [
  EXACT_MATCH_EVALUATOR_ID,
  ENTITY_F1_EVALUATOR_ID,
] as const;

export type ConfigurableTextEvaluatorId = (typeof CONFIGURABLE_TEXT_EVALUATOR_IDS)[number];
export type MultiCandidateScoring = 'any' | 'fraction';
export type EntityMatchMode = 'exact' | 'fuzzy' | 'substring';

export interface ExactMatchRunConfig {
  caseSensitive: boolean;
  punctuationInsensitive: boolean;
  whitespaceNormalization: boolean;
  widthNormalization: boolean;
  multiCandidateScoring: MultiCandidateScoring;
}

export interface EntityF1RunConfig {
  matchMode: EntityMatchMode;
  fuzzyThreshold: number;
  caseSensitive: boolean;
  widthNormalization: boolean;
  whitespaceNormalization: boolean;
}

export interface EvaluatorRunConfigMap {
  [EXACT_MATCH_EVALUATOR_ID]?: ExactMatchRunConfig;
  [ENTITY_F1_EVALUATOR_ID]?: EntityF1RunConfig;
}

interface StoredEvaluatorRunConfigsV1 {
  schemaVersion: 1;
  configs: EvaluatorRunConfigMap;
}

export const DEFAULT_EXACT_MATCH_RUN_CONFIG: Readonly<ExactMatchRunConfig> = Object.freeze({
  caseSensitive: true,
  punctuationInsensitive: false,
  whitespaceNormalization: false,
  widthNormalization: false,
  multiCandidateScoring: 'any',
});

export const DEFAULT_ENTITY_F1_RUN_CONFIG: Readonly<EntityF1RunConfig> = Object.freeze({
  matchMode: 'exact',
  fuzzyThreshold: 1,
  caseSensitive: true,
  widthNormalization: false,
  whitespaceNormalization: false,
});

export class EvaluatorRunConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluatorRunConfigValidationError';
  }
}

export function isConfigurableTextEvaluatorId(id: string): id is ConfigurableTextEvaluatorId {
  return (CONFIGURABLE_TEXT_EVALUATOR_IDS as readonly string[]).includes(id);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownFields(
  id: ConfigurableTextEvaluatorId,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new EvaluatorRunConfigValidationError(
      `${id} 包含不支持的配置字段：${unknown.join(', ')}`,
    );
  }
}

function readBoolean(
  id: ConfigurableTextEvaluatorId,
  value: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = value[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new EvaluatorRunConfigValidationError(`${id}.${key} 必须是 boolean`);
  }
  return raw;
}

export function normalizeExactMatchRunConfig(value: unknown): ExactMatchRunConfig {
  if (value === undefined || value === null) return { ...DEFAULT_EXACT_MATCH_RUN_CONFIG };
  if (!isPlainObject(value)) {
    throw new EvaluatorRunConfigValidationError(`${EXACT_MATCH_EVALUATOR_ID} 配置必须是对象`);
  }
  assertKnownFields(EXACT_MATCH_EVALUATOR_ID, value, [
    'caseSensitive',
    'punctuationInsensitive',
    'whitespaceNormalization',
    'widthNormalization',
    'multiCandidateScoring',
  ]);
  const scoring = value.multiCandidateScoring ?? DEFAULT_EXACT_MATCH_RUN_CONFIG.multiCandidateScoring;
  if (scoring !== 'any' && scoring !== 'fraction') {
    throw new EvaluatorRunConfigValidationError(
      `${EXACT_MATCH_EVALUATOR_ID}.multiCandidateScoring 必须是 any 或 fraction`,
    );
  }
  return {
    caseSensitive: readBoolean(
      EXACT_MATCH_EVALUATOR_ID,
      value,
      'caseSensitive',
      DEFAULT_EXACT_MATCH_RUN_CONFIG.caseSensitive,
    ),
    punctuationInsensitive: readBoolean(
      EXACT_MATCH_EVALUATOR_ID,
      value,
      'punctuationInsensitive',
      DEFAULT_EXACT_MATCH_RUN_CONFIG.punctuationInsensitive,
    ),
    whitespaceNormalization: readBoolean(
      EXACT_MATCH_EVALUATOR_ID,
      value,
      'whitespaceNormalization',
      DEFAULT_EXACT_MATCH_RUN_CONFIG.whitespaceNormalization,
    ),
    widthNormalization: readBoolean(
      EXACT_MATCH_EVALUATOR_ID,
      value,
      'widthNormalization',
      DEFAULT_EXACT_MATCH_RUN_CONFIG.widthNormalization,
    ),
    multiCandidateScoring: scoring,
  };
}

export function normalizeEntityF1RunConfig(value: unknown): EntityF1RunConfig {
  if (value === undefined || value === null) return { ...DEFAULT_ENTITY_F1_RUN_CONFIG };
  if (!isPlainObject(value)) {
    throw new EvaluatorRunConfigValidationError(`${ENTITY_F1_EVALUATOR_ID} 配置必须是对象`);
  }
  assertKnownFields(ENTITY_F1_EVALUATOR_ID, value, [
    'matchMode',
    'fuzzyThreshold',
    'caseSensitive',
    'widthNormalization',
    'whitespaceNormalization',
  ]);
  const matchMode = value.matchMode ?? DEFAULT_ENTITY_F1_RUN_CONFIG.matchMode;
  if (matchMode !== 'exact' && matchMode !== 'fuzzy' && matchMode !== 'substring') {
    throw new EvaluatorRunConfigValidationError(
      `${ENTITY_F1_EVALUATOR_ID}.matchMode 必须是 exact、fuzzy 或 substring`,
    );
  }
  const fuzzyThreshold = value.fuzzyThreshold ?? DEFAULT_ENTITY_F1_RUN_CONFIG.fuzzyThreshold;
  if (!Number.isInteger(fuzzyThreshold) || Number(fuzzyThreshold) < 0 || Number(fuzzyThreshold) > 100) {
    throw new EvaluatorRunConfigValidationError(
      `${ENTITY_F1_EVALUATOR_ID}.fuzzyThreshold 必须是 0 到 100 的整数`,
    );
  }
  return {
    matchMode,
    fuzzyThreshold: Number(fuzzyThreshold),
    caseSensitive: readBoolean(
      ENTITY_F1_EVALUATOR_ID,
      value,
      'caseSensitive',
      DEFAULT_ENTITY_F1_RUN_CONFIG.caseSensitive,
    ),
    widthNormalization: readBoolean(
      ENTITY_F1_EVALUATOR_ID,
      value,
      'widthNormalization',
      DEFAULT_ENTITY_F1_RUN_CONFIG.widthNormalization,
    ),
    whitespaceNormalization: readBoolean(
      ENTITY_F1_EVALUATOR_ID,
      value,
      'whitespaceNormalization',
      DEFAULT_ENTITY_F1_RUN_CONFIG.whitespaceNormalization,
    ),
  };
}

export function normalizeEvaluatorRunConfigs(
  value: unknown,
  selectedEvaluatorIds: readonly string[],
): EvaluatorRunConfigMap {
  const raw = value === undefined || value === null ? {} : value;
  if (!isPlainObject(raw)) {
    throw new EvaluatorRunConfigValidationError('evaluatorConfigs 必须是对象');
  }

  const selected = new Set(selectedEvaluatorIds);
  for (const id of Object.keys(raw)) {
    if (!isConfigurableTextEvaluatorId(id)) {
      throw new EvaluatorRunConfigValidationError(`评估器 ${id} 不支持运行配置`);
    }
    if (!selected.has(id)) {
      throw new EvaluatorRunConfigValidationError(`未选择评估器 ${id}，不能提交其运行配置`);
    }
  }

  const configs: EvaluatorRunConfigMap = {};
  if (selected.has(EXACT_MATCH_EVALUATOR_ID)) {
    configs[EXACT_MATCH_EVALUATOR_ID] = normalizeExactMatchRunConfig(raw[EXACT_MATCH_EVALUATOR_ID]);
  }
  if (selected.has(ENTITY_F1_EVALUATOR_ID)) {
    configs[ENTITY_F1_EVALUATOR_ID] = normalizeEntityF1RunConfig(raw[ENTITY_F1_EVALUATOR_ID]);
  }
  return configs;
}

export function serializeEvaluatorRunConfigs(
  value: unknown,
  selectedEvaluatorIds: readonly string[],
): string {
  const payload: StoredEvaluatorRunConfigsV1 = {
    schemaVersion: 1,
    configs: normalizeEvaluatorRunConfigs(value, selectedEvaluatorIds),
  };
  return JSON.stringify(payload);
}

export function parseStoredEvaluatorRunConfigs(
  stored: string | null | undefined,
  selectedEvaluatorIds: readonly string[],
): EvaluatorRunConfigMap {
  if (!stored || !stored.trim()) return normalizeEvaluatorRunConfigs({}, selectedEvaluatorIds);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new EvaluatorRunConfigValidationError('实验评估器配置不是有效 JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new EvaluatorRunConfigValidationError('实验评估器配置必须是对象');
  }
  if ('schemaVersion' in parsed || 'configs' in parsed) {
    if (parsed.schemaVersion !== 1) {
      throw new EvaluatorRunConfigValidationError('不支持的实验评估器配置版本');
    }
    return normalizeEvaluatorRunConfigs(parsed.configs, selectedEvaluatorIds);
  }
  // 兼容早期未带版本包装的配置，以及数据库默认值 `{}`。
  return normalizeEvaluatorRunConfigs(parsed, selectedEvaluatorIds);
}

export function summarizeEvaluatorRunConfig(
  id: string,
  config: EvaluatorRunConfigMap[ConfigurableTextEvaluatorId] | undefined,
): string | null {
  if (id === EXACT_MATCH_EVALUATOR_ID) {
    const normalized = normalizeExactMatchRunConfig(config);
    const normalization = [
      !normalized.caseSensitive ? '忽略大小写' : null,
      normalized.punctuationInsensitive ? '忽略标点' : null,
      normalized.whitespaceNormalization ? '归一化空白' : null,
      normalized.widthNormalization ? '统一全半角' : null,
    ].filter(Boolean);
    return [
      normalization.length > 0 ? normalization.join('、') : '严格文本',
      normalized.multiCandidateScoring === 'any' ? '候选任一命中' : '候选按比例计分',
    ].join(' · ');
  }
  if (id === ENTITY_F1_EVALUATOR_ID) {
    const normalized = normalizeEntityF1RunConfig(config);
    const modes: Record<EntityMatchMode, string> = {
      exact: '精确匹配',
      fuzzy: `模糊匹配（距离≤${normalized.fuzzyThreshold}）`,
      substring: '子串匹配',
    };
    const normalization = [
      !normalized.caseSensitive ? '忽略大小写' : null,
      normalized.whitespaceNormalization ? '归一化空白' : null,
      normalized.widthNormalization ? '统一全半角' : null,
    ].filter(Boolean);
    return [modes[normalized.matchMode], ...normalization].join(' · ');
  }
  return null;
}
