export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }
export type JsonSchema = boolean | {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | Array<'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'>
  title?: string; description?: string; default?: JsonValue; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: JsonSchema; items?: JsonSchema; enum?: JsonValue[]; const?: JsonValue
  minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; minProperties?: number; maxProperties?: number; $schema?: string
}
export type ParameterValue = string | number | boolean
export type AgentOptions = { version?: 2; runtimeKey: string; definitionDigest: string; values: JsonObject }
export type ParameterField = { key: string; group: string; label: string; description?: string; type: 'integer' | 'number' | 'string' | 'boolean' | 'enum'; required?: boolean; default?: ParameterValue; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; choices?: ParameterValue[] }
export type RuntimeDefinition = { runtimeKey: string; displayName: string; definitionDigest: string; templateRevision?: string; targets: Array<{ platform: string; agent: string }>; parameterGroups: Array<{ key: string; label: string; description?: string }>; parameters: ParameterField[]; presets: Array<{ key: string; label: string; values: JsonObject }>; configuration?: { version: 2; defaults: JsonObject; schema?: JsonSchema; delivery?: string; structure?: string } }
export function parseParameterJson(text: string): JsonObject
export function formatParameterJson(value: unknown): string
export function validateParameterObject(value: unknown, schema?: JsonSchema): JsonObject
export function validateDefinition(value: unknown): RuntimeDefinition
export function validateValues(definition: RuntimeDefinition, values: unknown, fillDefaults?: boolean): JsonObject
export function validateExecutionValues(definition: RuntimeDefinition, values: unknown, fillDefaults?: boolean): JsonObject
export function definitionsForTarget(definitions: RuntimeDefinition[], platform: string, agent: string): RuntimeDefinition[]
export function normalizeAgentOptions(value: unknown, definition?: RuntimeDefinition): AgentOptions | undefined
export function resolveAgentOptions(definitions: RuntimeDefinition[], platform: string, agent: string, value?: unknown): { agentOptions?: AgentOptions; definition?: RuntimeDefinition }
export function optionsToInputs(definition: RuntimeDefinition, options?: unknown): Record<string, string>
export function parseOptionInputs(definition: RuntimeDefinition, inputs: Record<string, string>): AgentOptions
export function summarizeOptions(definition?: RuntimeDefinition | null, options?: AgentOptions | null): string
