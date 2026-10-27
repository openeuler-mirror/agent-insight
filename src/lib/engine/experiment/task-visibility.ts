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

import { prisma } from '@/lib/storage/prisma';

export async function visibleExperimentTask<T extends { configJson?: object; caseStatesJson?: object }>(task: T): Promise<T | null> {
  const experimentId = (task.configJson as { evalExperimentId?: unknown } | undefined)?.evalExperimentId;
  if (typeof experimentId !== 'string' || !experimentId) return task;
  const experiment = await prisma.experiment.findUnique({ where: { id: experimentId }, select: { deletedAt: true } });
  if (experiment?.deletedAt) return null;
  const cancellations: Array<{ caseKey: string }> = await prisma.experimentCancellation.findMany({ where: { experimentId }, select: { caseKey: true } });
  const deleted = new Set(cancellations.filter((row) => row.caseKey.startsWith('dataset:')).map((row) => row.caseKey.slice(8)));
  return { ...task, caseStatesJson: Object.fromEntries(Object.entries(task.caseStatesJson || {}).filter(([key]) => !deleted.has(key))) };
}
