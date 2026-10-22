import type { AgentOptions, RuntimeDefinition } from './index.cjs'

export type OptionMigration = {
  options: AgentOptions
}

export function proposeOptionMigration(savedDefinition: RuntimeDefinition | undefined, currentDefinition: RuntimeDefinition, input: unknown): OptionMigration | undefined
