import {
  MCTS_OPTION_FIELDS, MCTS_SEARCH_OPTIONS_CAPABILITY, normalizeAgentOptions, parseMctsOptionInputs,
  type AgentOptions, type MctsRunOptions,
} from '../../../../services/executor/src/mcts-options.cjs'

export { MCTS_OPTION_FIELDS, MCTS_QUICK_OPTIONS } from '../../../../services/executor/src/mcts-options.cjs'
export type MctsOptionInputs = Partial<Record<keyof MctsRunOptions, string>>

export function mctsOptionsToInputs(value: unknown): MctsOptionInputs {
  const options = normalizeAgentOptions(value)
  return Object.fromEntries(MCTS_OPTION_FIELDS.filter(field => options?.mcts?.[field.key] !== undefined)
    .map(field => [field.key, String(options!.mcts![field.key])]))
}

export function mctsOptionsState(target: { platform: string; agentOptionCapabilities?: string[] } | null,
  inputs: MctsOptionInputs, configuredPlatform: string): { active: boolean; agentOptions?: AgentOptions; error: string | null } {
  const supported = Boolean(target?.agentOptionCapabilities?.includes(MCTS_SEARCH_OPTIONS_CAPABILITY))
  const filled = Object.values(inputs).some(value => Boolean(value?.trim()))
  const active = supported || Boolean(target && filled && target.platform === configuredPlatform)
  if (!active) return { active: false, error: null }
  try {
    const agentOptions = parseMctsOptionInputs(inputs)
    if (agentOptions && !supported) return { active, error: '所选客户端不支持 MCTS 搜索参数，请升级客户端或恢复默认参数' }
    return { active, agentOptions, error: null }
  } catch (error) {
    return { active, error: error instanceof Error ? error.message : 'MCTS 参数不合法' }
  }
}

export function summarizeMctsOptions(value: unknown): string {
  const options = normalizeAgentOptions(value)
  return MCTS_OPTION_FIELDS.filter(field => options?.mcts?.[field.key] !== undefined)
    .map(field => `${field.label}：${field.key === 'tokenFuseLimit' && options!.mcts![field.key] === 0 ? '关闭' : options!.mcts![field.key]}`)
    .join('；') || '沿用 MCTS 配置'
}
