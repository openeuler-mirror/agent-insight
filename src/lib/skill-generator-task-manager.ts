/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
