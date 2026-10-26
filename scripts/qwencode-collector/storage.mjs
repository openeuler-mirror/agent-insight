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

import { getAgentInsightHome } from './configure.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const collectorBaseRoot = join(getAgentInsightHome(), 'otel_data', 'qwencode');

function qwenDotEnvValue(name) {
  const path = join(homedir(), '.qwen', '.env');
  if (!existsSync(path)) return undefined;
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || line.trimStart().startsWith('#') || match[1] !== name) continue;
      return match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
    }
  } catch {
    // The collector must still work with a process-level API key if .env is
    // temporarily unavailable while Qwen starts.
  }
  return undefined;
}

export function configuredApiKey() {
  return process.env.AGENT_INSIGHT_API_KEY || qwenDotEnvValue('AGENT_INSIGHT_API_KEY') || '';
}

export function accountScope(apiKey = configuredApiKey()) {
  if (!apiKey) return 'anonymous';
  return `key-${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
}

export function collectorRoot() {
  return join(collectorBaseRoot, accountScope());
}
