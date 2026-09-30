export type MctsRunOptions = {
  maxIters?: number
  branching?: number
  maxTurnsInit?: number
  maxTurnsStep?: number
  maxTurnsAuthor?: number
  maxTurnsAuthorStep?: number
  tokenFuseLimit?: number
}
export type AgentOptions = { mcts?: MctsRunOptions }
export const MCTS_SEARCH_OPTIONS_CAPABILITY: 'mcts-search-options/v1'
export const MCTS_RUNTIMES: Readonly<Record<string, string>>
export const MCTS_OPTION_FIELDS: ReadonlyArray<{ key: keyof MctsRunOptions; flag: string; label: string; min: number }>
export const MCTS_QUICK_OPTIONS: Readonly<Required<MctsRunOptions>>
export function normalizeAgentOptions(value: unknown): AgentOptions | undefined
export function parseMctsOptionInputs(inputs: Partial<Record<keyof MctsRunOptions, string>>): AgentOptions | undefined
export function mctsOptionArgs(options: unknown): string[]
