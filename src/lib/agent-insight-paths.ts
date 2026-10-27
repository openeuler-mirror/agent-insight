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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentInsightHome } from './env';

export function getPreferredInsightDir(): string {
  return getAgentInsightHome();
}

export function getLegacyInsightDir(): string {
  return path.join(os.homedir(), '.skill-insight');
}

export function getExistingInsightDir(): string {
  const preferred = getPreferredInsightDir();
  if (process.env.AGENT_INSIGHT_HOME) return preferred;
  const legacy = getLegacyInsightDir();
  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

export function getInsightEnvCandidates(): string[] {
  return [
    path.join(getPreferredInsightDir(), '.env'),
    path.join(getLegacyInsightDir(), '.env'),
  ];
}
