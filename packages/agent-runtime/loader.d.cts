import type { AgentOptions, RuntimeDefinition } from './index.cjs'
type Settings = { root?: string; configDir?: string; env?: Readonly<Record<string, string | undefined>> }
type Mapping = { path: string; flag: string; falseFlag?: string; encoding?: 'json' | 'repeat' | 'join'; booleanStyle?: 'value' | 'switch'; separator?: string }
export type RuntimeInvocationPlan = { agentOptions?: AgentOptions; definition?: RuntimeDefinition; args: string[]; env: Record<string, string>; parameterFile?: { contents: string; flag?: string; env: string } }
export function loadRuntimeDefinitions(settings?: Settings): Array<{ descriptor: RuntimeDefinition; bindings: Map<string, { kind: 'argv'; flag: string; falseFlag?: string }>; deliveryBinding?: { mode?: 'passthrough'; flag?: string; env?: string; mappings?: Mapping[] } }>
export function runtimeInvocationOptions(platform: string, agent: string, options?: unknown, settings?: Settings): RuntimeInvocationPlan
export function prepareRuntimeInvocation(plan: RuntimeInvocationPlan, baseDir: string): { args: string[]; env: Record<string, string>; cleanup(): void }
