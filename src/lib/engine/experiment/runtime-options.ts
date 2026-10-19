import { definitionsForTarget, normalizeAgentOptions, optionsToInputs, parseOptionInputs, type AgentOptions, type RuntimeDefinition } from '../../../../packages/agent-runtime/index.cjs'

export { optionsToInputs, summarizeOptions } from '../../../../packages/agent-runtime/index.cjs'
export type { AgentOptions, RuntimeDefinition } from '../../../../packages/agent-runtime/index.cjs'
export type RuntimeOptionInputs = Record<string, string>

export function readSavedOptions(value: unknown): AgentOptions | undefined {
  try { return normalizeAgentOptions(value) } catch { return undefined }
}

export function runtimeOptionsState(target: { platform: string; agent: string; parameterDefinitions?: RuntimeDefinition[] } | null,
  inputs: RuntimeOptionInputs, configuredTarget: string, currentTarget: string, restored?: AgentOptions): {
    active: boolean; definition?: RuntimeDefinition; inputs: RuntimeOptionInputs; agentOptions?: AgentOptions; error: string | null
  } {
  if (!target) return { active: false, inputs: {}, error: null }
  const definition = definitionsForTarget(target.parameterDefinitions || [], target.platform, target.agent)[0]
  const usingSaved = configuredTarget === currentTarget
  if (!definition || !definition.parameters.length) return {
    active: false, inputs: {}, error: usingSaved && restored ? '该执行目标已不再提供原参数定义，请选择其他执行目标' : null,
  }
  let effectiveInputs = inputs
  try {
    if (!usingSaved) effectiveInputs = optionsToInputs(definition)
    if (usingSaved && restored) normalizeAgentOptions(restored, definition)
    return { active: true, definition, inputs: effectiveInputs, agentOptions: parseOptionInputs(definition, effectiveInputs), error: null }
  } catch (error) {
    return { active: true, definition, inputs: effectiveInputs, error: error instanceof Error ? error.message : 'Runtime 参数不合法' }
  }
}
