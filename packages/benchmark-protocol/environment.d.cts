export const PROTOCOL: 'execution-environment/v1'
export const ACTION: 'PREPARE_EXECUTION_ENVIRONMENT'
export const TIMEOUT_MS: number
export type EnvironmentContext = {
  protocol: typeof PROTOCOL
  clientId: string
  dataset: { id: string; adapterKey: string; revision: string; caseIds: string[]; faultTypes: string[] }
  platform: string
  agent: string
  model: string
  agentOptions?: Record<string, unknown>
  experiment: { mode: 'generate' | 'skill-ab' | 'trigger'; timeoutSeconds: number; concurrency: number }
}
export type EnvironmentState = 'checking' | 'preparing' | 'needs_action' | 'ready' | 'failed'
export type EnvironmentTask = {
  taskId: string
  contextDigest: string
  state: EnvironmentState
  message: string
  issues: Array<{ code: string; message: string }>
  durationHint?: 'first_install_minutes' | 'minutes'
}
export function validateContext(value: unknown): EnvironmentContext
export function contextDigest(value: EnvironmentContext): string
export function preparationMessage(state: string, durationHint?: string): string
