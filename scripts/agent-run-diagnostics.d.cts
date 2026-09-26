export interface AgentRunFacts {
  traceId?: string;
  startedAt?: string;
  finishedAt?: string;
  [key: string]: unknown;
}

export type AgentRunError = Error & { code: string; runFacts?: AgentRunFacts };
export function extractStructuredAgentError(value: unknown): string | null;
export function sanitizeAgentDiagnostic(value: unknown, maxLength?: number): string;
export function classifyAgentExitFailure(input: {
  platform: string;
  exitCode?: number | null;
  signal?: string | null;
  diagnostic?: unknown;
  structured?: boolean;
}): { code: string; message: string };
export function createAgentRunError(code: string, message: string, runFacts?: AgentRunFacts): AgentRunError;
export interface OpencodeFailureEvent {
  type?: string;
  error?: string | null;
  modelResponse?: boolean;
  retry?: { message?: string; attempt?: number | string };
}
export function createOpencodeFailureMonitor(options: {
  inspectEvent: (line: string) => OpencodeFailureEvent | null;
  onFailure: (code: string, message: string) => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}): {
  onEvent(event: OpencodeFailureEvent | null): void;
  onStderr(chunk: string): void;
  finish(): { code: string; message: string; detectedAt: string } | null;
  dispose(): void;
};
