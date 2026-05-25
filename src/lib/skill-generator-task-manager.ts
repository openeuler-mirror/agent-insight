type SkillGeneratorRunRecord = {
  user: string;
  threadId: string;
  runId: string;
  controller: AbortController;
  startedAt: number;
};

const activeRuns = new Map<string, SkillGeneratorRunRecord>();

function makeKey(user: string, threadId: string): string {
  return `${user}::${threadId}`;
}

function generateRunId(): string {
  return `skill_generator_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function startOrReplaceSkillGeneratorRun(
  user: string,
  threadId: string
): { runId: string; controller: AbortController; replacedRunId?: string } {
  const key = makeKey(user, threadId);
  const runId = generateRunId();
  const controller = new AbortController();
  const existing = activeRuns.get(key);

  let replacedRunId: string | undefined;
  if (existing) {
    replacedRunId = existing.runId;
    existing.controller.abort("superseded");
  }

  activeRuns.set(key, {
    user,
    threadId,
    runId,
    controller,
    startedAt: Date.now(),
  });

  return { runId, controller, replacedRunId };
}

export function cancelSkillGeneratorRun(
  user: string,
  threadId: string
): { cancelled: boolean; runId?: string } {
  const key = makeKey(user, threadId);
  const existing = activeRuns.get(key);
  if (!existing) return { cancelled: false };

  existing.controller.abort("cancelled");
  return { cancelled: true, runId: existing.runId };
}

export function finishSkillGeneratorRun(user: string, threadId: string, runId: string): void {
  const key = makeKey(user, threadId);
  const existing = activeRuns.get(key);
  if (!existing) return;
  if (existing.runId !== runId) return;
  activeRuns.delete(key);
}
