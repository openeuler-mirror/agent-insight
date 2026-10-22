import type { AgentDebugModule } from './types';

export type DiagnosisProgressModule = Exclude<AgentDebugModule, 'others' | 'unknown'> | 'skills';
export interface DiagnosisProgressInput {
  key: string;
  kind: 'task' | 'tool' | 'evidence' | 'analysis' | 'stage';
  module?: DiagnosisProgressModule;
  state: 'started' | 'update' | 'completed' | 'failed' | 'skipped';
  title: string;
  summary: string;
  refs?: Array<{ traceStepIndex: number; anchorId?: string }>;
}

export interface DiagnosisProgressEvent extends DiagnosisProgressInput {
  seq: number;
  at: string;
}

export interface DiagnosisProgressSnapshot {
  runId: string;
  events: DiagnosisProgressEvent[];
  lastProgressAt: string | null;
  unavailable: boolean;
  truncated: boolean;
}

export interface DiagnosisProgressWriter {
  runId: string;
  emit: (event: DiagnosisProgressInput) => void;
  snapshot: () => DiagnosisProgressSnapshot;
  unavailable: () => void;
}
