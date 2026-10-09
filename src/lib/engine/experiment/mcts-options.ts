import {
  MCTS_DEFAULT_OPTIONS, MCTS_OPTION_FIELDS, MCTS_SEARCH_OPTIONS_CAPABILITY, normalizeAgentOptions, parseMctsOptionInputs,
  type AgentOptions, type MctsRunOptions,
} from '../../../../services/executor/src/mcts-options.cjs'

export { MCTS_DEFAULT_OPTIONS, MCTS_OPTION_FIELDS, MCTS_QUICK_OPTIONS } from '../../../../services/executor/src/mcts-options.cjs'
export type MctsOptionInputs = Partial<Record<keyof MctsRunOptions, string>>

export function mctsOptionsToInputs(value: unknown): MctsOptionInputs {
  const options = normalizeAgentOptions(value)
  const values = { ...MCTS_DEFAULT_OPTIONS, ...options?.mcts }
  return Object.fromEntries(MCTS_OPTION_FIELDS.map(field => [field.key, String(values[field.key])]))
}

export function mctsOptionsState(target: { platform: string; agentOptionCapabilities?: string[] } | null,
  inputs: MctsOptionInputs, configuredPlatform: string, benchmarkKey: string | undefined): { active: boolean; agentOptions?: AgentOptions; error: string | null } {
  if (benchmarkKey !== 'swe-bench') return { active: false, error: null }
  const supported = Boolean(target?.agentOptionCapabilities?.includes(MCTS_SEARCH_OPTIONS_CAPABILITY))
  const filled = Object.values(inputs).some(value => Boolean(value?.trim()))
  const active = supported || Boolean(target && filled && target.platform === configuredPlatform)
  if (!active) return { active: false, error: null }
  try {
    const agentOptions = parseMctsOptionInputs(inputs)
    if (agentOptions && !supported) return { active, error: '所选客户端不支持 MCTS 搜索参数，请升级客户端' }
    return { active, agentOptions, error: null }
  } catch (error) {
    return { active, error: error instanceof Error ? error.message : 'MCTS 参数不合法' }
  }
}

export function summarizeMctsOptions(value: unknown): string {
  const options = normalizeAgentOptions(value)
  return MCTS_OPTION_FIELDS.filter(field => options?.mcts?.[field.key] !== undefined)
    .map(field => `${field.label}：${field.key === 'tokenFuseLimit' && options!.mcts![field.key] === 0 ? '关闭' : options!.mcts![field.key]}`)
    .join('；') || '未记录搜索参数（历史配置）'
}
