export type ParameterValue = string | number | boolean
export type AgentOptions = { runtimeKey: string; definitionDigest: string; values: Record<string, ParameterValue> }
export type ParameterField = { key: string; group: string; label: string; description?: string; type: 'integer' | 'number' | 'string' | 'boolean' | 'enum'; required?: boolean; default?: ParameterValue; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; choices?: ParameterValue[] }
export type RuntimeDefinition = { runtimeKey: string; displayName: string; definitionDigest: string; targets: Array<{ platform: string; agent: string }>; parameterGroups: Array<{ key: string; label: string; description?: string }>; parameters: ParameterField[]; presets: Array<{ key: string; label: string; values: Record<string, ParameterValue> }> }
export function validateDefinition(value: unknown): RuntimeDefinition
export function validateValues(definition: RuntimeDefinition, values: unknown, fillDefaults?: boolean): Record<string, ParameterValue>
export function definitionsForTarget(definitions: RuntimeDefinition[], platform: string, agent: string): RuntimeDefinition[]
export function normalizeAgentOptions(value: unknown, definition?: RuntimeDefinition): AgentOptions | undefined
export function resolveAgentOptions(definitions: RuntimeDefinition[], platform: string, agent: string, value?: unknown): { agentOptions?: AgentOptions; definition?: RuntimeDefinition }
export function optionsToInputs(definition: RuntimeDefinition, options?: unknown): Record<string, string>
export function parseOptionInputs(definition: RuntimeDefinition, inputs: Record<string, string>): AgentOptions
export function summarizeOptions(definition?: RuntimeDefinition | null, options?: AgentOptions | null): string
