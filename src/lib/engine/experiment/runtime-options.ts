import { definitionsForTarget, formatParameterJson, normalizeAgentOptions, optionsToInputs, parseOptionInputs, validateDefinition, type AgentOptions, type RuntimeDefinition } from '../../../../packages/agent-runtime/index.cjs'
import { proposeOptionMigration, type OptionMigration } from '../../../../packages/agent-runtime/option-migration.cjs'

export { optionsToInputs, summarizeOptions } from '../../../../packages/agent-runtime/index.cjs'
export type { AgentOptions, RuntimeDefinition } from '../../../../packages/agent-runtime/index.cjs'
export type RuntimeOptionInputs = Record<string, string>
export type RuntimeDraft = { inputs: RuntimeOptionInputs; restored?: AgentOptions; restoredDefinition?: RuntimeDefinition }

export function initializeRuntimeDraft(drafts: Record<string, RuntimeDraft>, key: string, definition: RuntimeDefinition): Record<string, RuntimeDraft> {
  if (Object.hasOwn(drafts, key)) return drafts
  return { ...drafts, [key]: { inputs: optionsToInputs(definition) } }
}

export function readSavedOptions(value: unknown): AgentOptions | undefined {
  try { return normalizeAgentOptions(value) } catch { return undefined }
}

export function readSavedDefinition(value: unknown): RuntimeDefinition | undefined {
  try { return validateDefinition(value) } catch { return undefined }
}

export function savedOptionsToInputs(options?: AgentOptions): RuntimeOptionInputs {
  if (options?.version === 2) return { __json: formatParameterJson(options.values) }
  return Object.fromEntries(Object.entries(options?.values || {}).map(([key, value]) => [key, String(value)]))
}

export function runtimeOptionsState(target: { platform: string; agent: string; parameterDefinitions?: RuntimeDefinition[] } | null,
  inputs: RuntimeOptionInputs, configuredTarget: string, currentTarget: string, restored?: AgentOptions, restoredDefinition?: RuntimeDefinition): {
    active: boolean; definition?: RuntimeDefinition; inputs: RuntimeOptionInputs; agentOptions?: AgentOptions; error: string | null; migration?: OptionMigration
  } {
  if (!target) return { active: false, inputs: {}, error: null }
  const definition = definitionsForTarget(target.parameterDefinitions || [], target.platform, target.agent)[0]
  const usingSaved = configuredTarget === currentTarget
  if (!definition || (!definition.configuration && !definition.parameters.length)) return {
    active: false, inputs: {}, error: usingSaved && restored ? '该执行目标已不再提供原参数定义，请选择其他执行目标' : null,
  }
  let effectiveInputs = inputs
  try {
    if (!usingSaved) effectiveInputs = optionsToInputs(definition)
    if (usingSaved && restored && definition.configuration?.version === 2 && effectiveInputs.__json === undefined) {
      effectiveInputs = { __json: formatParameterJson(restored.values) }
    }
    if (usingSaved && restored) normalizeAgentOptions(restored, definition)
    const agentOptions = parseOptionInputs(definition, effectiveInputs)
    return { active: true, definition, inputs: effectiveInputs, agentOptions, error: null }
  } catch (error) {
    const migration = usingSaved && restored ? proposeOptionMigration(restoredDefinition, definition, restored) : undefined
    return { active: true, definition, inputs: effectiveInputs,
      error: migration ? '参数契约已变化，请确认原配置后用于新实验' : error instanceof Error ? error.message : 'Runtime 参数不合法',
      ...(migration ? { migration } : {}) }
  }
}
