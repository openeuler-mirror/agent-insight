export type ExecutionProfile = {
  key: string; backendKey: string; sandbox: string; sourceRevision: string; implementationDigest: string; network: 'deny'
  artifactDigest?: string
  resources: { cpu: number; memoryMiB: number; pids: number }
  timeouts: { prepareSeconds: number; cleanupSeconds: number }
  targets: Array<{ platform: string; agents: string[] }>; models: string[]; definitionDigest: string
}
export type ExecutionSpec = { profile: ExecutionProfile; environment: { kind: 'oci-image'; image: string; arch: 'amd64' | 'arm64'; workspaceRoot: string } }
export type ExecutionProfileCapability = { profile: ExecutionProfile; benchmarks: string[]; ready: boolean; note?: string }
export function validateProfile(value: unknown): ExecutionProfile
export function validateExecution(value: unknown): ExecutionSpec
export function digest(value: unknown): string
export const DEFAULT_BINDINGS: Array<{ benchmarks: string[]; platforms: string[]; profile: string }>
export function bindingFor(bindings: typeof DEFAULT_BINDINGS, benchmark: string, platform: string): typeof DEFAULT_BINDINGS[number] | undefined
