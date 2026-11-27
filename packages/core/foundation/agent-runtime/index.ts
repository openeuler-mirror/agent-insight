import type { CallContext } from '../common/context/call-context';
import type { ArtifactRef } from '../common/shared-interfaces/artifact-ref';

export interface AgentRuntimeInput {
  readonly agentKey: string;
  readonly prompt: string;
  readonly inputs?: readonly ArtifactRef[];
  readonly timeoutMs?: number;
}

export interface AgentRuntimeOutput {
  readonly text: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly traceId?: string;
}

export interface AgentRuntime {
  run(context: CallContext, input: AgentRuntimeInput): Promise<AgentRuntimeOutput>;
}

export interface AgentRuntimeProvider extends AgentRuntime {
  readonly key: string;
  readonly version: string;
}
