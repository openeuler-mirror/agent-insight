type EvaluationSource = "upload" | "rejudge";

type EvaluationTaskRecord = {
  user: string;
  taskId: string;
  runId: string;
  source: EvaluationSource;
  status: "running" | "cancelling";
  startedAt: number;
};

const activeTasks = new Map<string, EvaluationTaskRecord>();

function makeKey(user: string, taskId: string): string {
  return `${user}::${taskId}`;
}

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function startOrReplace(
  user: string,
  taskId: string,
  source: EvaluationSource
): { runId: string; replacedRunId?: string } {
  const key = makeKey(user, taskId);
  const runId = generateRunId();
  let replacedRunId: string | undefined;

  const existing = activeTasks.get(key);
  if (existing) {
    existing.status = "cancelling";
    replacedRunId = existing.runId;
    console.log(`[EvalTask] replaced user=${user} task=${taskId} oldRun=${replacedRunId} newRun=${runId} source=${source}`);
  } else {
    console.log(`[EvalTask] start user=${user} task=${taskId} run=${runId} source=${source}`);
  }

  activeTasks.set(key, {
    user,
    taskId,
    runId,
    source,
    status: "running",
    startedAt: Date.now()
  });

  return { runId, replacedRunId };
}

export function cancel(
  user: string,
  taskId: string
): { cancelled: boolean; runId?: string } {
  const key = makeKey(user, taskId);
  const existing = activeTasks.get(key);

  if (!existing || existing.status !== "running") {
    console.log(`[EvalTask] cancel user=${user} task=${taskId} - no active task`);
    return { cancelled: false };
  }

  existing.status = "cancelling";
  console.log(`[EvalTask] cancel user=${user} task=${taskId} run=${existing.runId}`);
  return { cancelled: true, runId: existing.runId };
}

export function getActive(
  user: string,
  taskId: string
): EvaluationTaskRecord | null {
  const key = makeKey(user, taskId);
  const record = activeTasks.get(key);
  if (!record || record.status !== "running") {
    return null;
  }
  return record;
}

export function isActive(user: string, taskId: string): boolean {
  return getActive(user, taskId) !== null;
}

export class EvaluationCancelledError extends Error {
  constructor(message: string = "Evaluation cancelled") {
    super(message);
    this.name = "EvaluationCancelledError";
  }
}

export function assertActive(user: string, taskId: string, runId: string): void {
  const key = makeKey(user, taskId);
  const record = activeTasks.get(key);

  if (!record) {
    console.log(`[EvalTask] assertActive failed - no task user=${user} task=${taskId} run=${runId}`);
    throw new EvaluationCancelledError("No active evaluation task");
  }

  if (record.runId !== runId) {
    console.log(`[EvalTask] assertActive failed - runId mismatch user=${user} task=${taskId} expected=${runId} actual=${record.runId}`);
    throw new EvaluationCancelledError("Evaluation superseded by newer run");
  }

  if (record.status !== "running") {
    console.log(`[EvalTask] assertActive failed - status not running user=${user} task=${taskId} run=${runId} status=${record.status}`);
    throw new EvaluationCancelledError("Evaluation cancelled");
  }
}

export function finish(user: string, taskId: string, runId: string): void {
  const key = makeKey(user, taskId);
  const record = activeTasks.get(key);

  if (!record) {
    console.log(`[EvalTask] finish - no task user=${user} task=${taskId} run=${runId}`);
    return;
  }

  if (record.runId === runId) {
    activeTasks.delete(key);
    console.log(`[EvalTask] finish user=${user} task=${taskId} run=${runId}`);
  } else {
    console.log(`[EvalTask] finish skipped - runId mismatch user=${user} task=${taskId} expected=${runId} actual=${record.runId}`);
  }
}

export function isCancelled(user: string, taskId: string, runId: string): boolean {
  const key = makeKey(user, taskId);
  const record = activeTasks.get(key);

  if (!record) return true;
  if (record.runId !== runId) return true;
  if (record.status !== "running") return true;

  return false;
}