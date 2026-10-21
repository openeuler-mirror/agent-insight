import type { AgentOptions, JsonValue, RuntimeDefinition } from './index.cjs'

export type OptionMigration = {
  options: AgentOptions
  changes: Array<{ from: string; to: string; value: JsonValue }>
}

export function proposeOptionMigration(savedDefinition: RuntimeDefinition | undefined, currentDefinition: RuntimeDefinition, input: unknown): OptionMigration | undefined
