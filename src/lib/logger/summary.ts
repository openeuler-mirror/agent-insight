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

export function createProgressSummary(write: (fields: Record<string, unknown>) => void, now = Date.now) {
  let lastLoggedAt: number | undefined;
  let firstAt = 0, lastAt = 0, ticks = 0, discovered = 0, parseErrors = 0;
  let latest: Record<string, unknown> = {};
  const flush = () => {
    if (!ticks) return;
    try { write({ ...latest, ticks, discovered, parseErrors, firstAt: new Date(firstAt).toISOString(), lastAt: new Date(lastAt).toISOString() }); } catch {}
    lastLoggedAt = now();
    ticks = discovered = parseErrors = 0;
  };
  const flushIfDue = () => { if (lastLoggedAt === undefined || now() - lastLoggedAt >= 60_000) flush(); };
  return {
    record(fields: Record<string, unknown>) {
      if (!ticks) firstAt = now();
      lastAt = now(); ticks++;
      discovered += Number(fields.discovered) || 0;
      parseErrors += Number(fields.parseErrors) || 0;
      latest = fields;
      flushIfDue();
    },
    flushIfDue, flush,
  };
}
