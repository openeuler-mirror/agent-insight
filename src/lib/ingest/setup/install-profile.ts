export type FrameworkOption = {
  value: string;
  label: string;
};

export type GoalPlusHost = 'pi';

export const FRAMEWORK_OPTIONS: readonly FrameworkOption[] = [
  { value: 'opencode', label: 'OpenCode' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codeagent', label: 'CodeAgent' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'xiaoo', label: 'xiaoO' },
  { value: 'jiuwen', label: 'JiuwenSwarm' },
  { value: 'llamaindex', label: 'LlamaIndex' },
  { value: 'qoder', label: 'Qoder CN product family' },
  { value: 'trae', label: 'Trae IDE' },
  { value: 'actrail', label: 'AcTrail' },
  { value: 'pi-agent', label: 'Pi Agent' },
  { value: 'qwencode', label: 'Qwen Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'deepseek-harness', label: 'DeepSeek Harness' },
];

const LEGACY_GOAL_PLUS_OPTION = { value: 'goal-plus', label: 'Goal Plus' } as const;
const INSTALL_PROFILE_OPTIONS = [...FRAMEWORK_OPTIONS, LEGACY_GOAL_PLUS_OPTION];
const FRAMEWORK_BY_VALUE = new Map(INSTALL_PROFILE_OPTIONS.map(option => [option.value, option]));

export function parseFrameworks(raw: string | null): FrameworkOption[] {
  if (!raw) return [];
  const wanted = new Set(raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  return INSTALL_PROFILE_OPTIONS.filter(option => wanted.has(option.value)).map(option => ({ ...option }));
}

export function resolveInstallProfile(
  requestedFrameworks: readonly FrameworkOption[],
): {
  requestedFrameworks: FrameworkOption[];
  effectiveFrameworks: FrameworkOption[];
  goalPlusHosts: GoalPlusHost[];
  autoAddedFrameworks: FrameworkOption[];
} {
  const requested = requestedFrameworks
    .map(option => FRAMEWORK_BY_VALUE.get(option.value))
    .filter((option): option is FrameworkOption => Boolean(option))
    .map(option => ({ ...option }));
  const hasGoalPlus = requested.some(option => option.value === 'goal-plus');
  const goalPlusHosts: GoalPlusHost[] = [];
  const effective = requested.filter(option => option.value !== 'goal-plus');
  const autoAdded: FrameworkOption[] = [];
  const addDependency = (value: string) => {
    if (effective.some(option => option.value === value)) return;
    const option = FRAMEWORK_BY_VALUE.get(value);
    if (!option) return;
    const copy = { ...option };
    effective.push(copy);
    autoAdded.push(copy);
  };
  if (hasGoalPlus) addDependency('pi-agent');
  return {
    requestedFrameworks: requested,
    effectiveFrameworks: effective,
    goalPlusHosts,
    autoAddedFrameworks: autoAdded,
  };
}
