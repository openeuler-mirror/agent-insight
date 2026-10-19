import type { AgentOptions, RuntimeDefinition } from './index.cjs'
type Settings = { root?: string; configDir?: string; env?: Readonly<Record<string, string | undefined>> }
export function loadRuntimeDefinitions(settings?: Settings): Array<{ descriptor: RuntimeDefinition; bindings: Map<string, { kind: 'argv'; flag: string; falseFlag?: string }> }>
export function runtimeInvocationOptions(platform: string, agent: string, options?: unknown, settings?: Settings): { agentOptions?: AgentOptions; definition?: RuntimeDefinition; args: string[] }
