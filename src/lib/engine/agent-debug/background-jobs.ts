export type AgentDebugBackgroundJobKind = 'agent-debug' | 'skills-analysis';

export interface ActiveAgentDebugBackgroundJob {
  kind: AgentDebugBackgroundJobKind;
  executionId: string;
  interactionsHash: string;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentDebugBackgroundJobs: Map<string, ActiveAgentDebugBackgroundJob> | undefined;
}

function jobKey(kind: AgentDebugBackgroundJobKind, executionId: string) {
  return `${kind}:${executionId}`;
}

function activeJobs() {
  if (!globalThis.__agentDebugBackgroundJobs) {
    globalThis.__agentDebugBackgroundJobs = new Map();
  }
  return globalThis.__agentDebugBackgroundJobs;
}

export function getActiveAgentDebugBackgroundJob(kind: AgentDebugBackgroundJobKind, executionId: string) {
  return activeJobs().get(jobKey(kind, executionId)) || null;
}

export function hasActiveAgentDebugBackgroundJob(
  kind: AgentDebugBackgroundJobKind,
  executionId: string,
  interactionsHash?: string,
) {
  const job = getActiveAgentDebugBackgroundJob(kind, executionId);
  if (!job) return false;
  return interactionsHash ? job.interactionsHash === interactionsHash : true;
}

export function setActiveAgentDebugBackgroundJob(job: ActiveAgentDebugBackgroundJob) {
  activeJobs().set(jobKey(job.kind, job.executionId), job);
}

export function clearActiveAgentDebugBackgroundJob(
  kind: AgentDebugBackgroundJobKind,
  executionId: string,
  interactionsHash?: string,
) {
  const key = jobKey(kind, executionId);
  const job = activeJobs().get(key);
  if (!job) return;
  if (interactionsHash && job.interactionsHash !== interactionsHash) return;
  activeJobs().delete(key);
}
