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

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveAgentInsightDataPath } from '@/lib/env';
import { verificationHash, validJudgment } from './verification-policy';

export interface VerificationEvidence {
  output: string;
  score?: number;
  reason?: string;
  judgeKey?: string;
  createdAt: number;
}

export async function inputEnvironmentKey(input: string): Promise<string | null> {
  if (/https?:\/\/|\b(?:localhost|www\.)|[A-Za-z]:[\\/]/i.test(input)) return null;
  const paths = [...input.matchAll(/(?:~?\/|\b[\w.-]+\/)[\w./~-]+/g)].map(([value]) => value.replace(/^~/, os.homedir()));
  const files: Record<string, string> = {};
  for (const file of new Set(paths)) {
    if (!path.isAbsolute(file)) return null;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
      files[file] = verificationHash((await fs.readFile(file)).toString('base64'));
    } catch { return null; }
  }
  return verificationHash({ host: os.hostname(), platform: os.platform(), release: os.release(), files });
}

export class VerificationCache {
  constructor(private readonly directory = resolveAgentInsightDataPath('skill-verification-cache')) {}

  async read(key: string): Promise<VerificationEvidence | null> {
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    try {
      const evidence = JSON.parse(await fs.readFile(path.join(this.directory, `${key}.json`), 'utf8')) as VerificationEvidence;
      if (!Number.isFinite(evidence.createdAt) || Date.now() - evidence.createdAt > 7 * 86400_000 || evidence.createdAt > Date.now()
        || typeof evidence.output !== 'string' || !evidence.output.trim()) return null;
      if (evidence.score !== undefined && !validJudgment({ score: evidence.score, reason: evidence.reason })) return null;
      return evidence;
    } catch { return null; }
  }

  async write(key: string, evidence: VerificationEvidence): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key) || !evidence.output.trim()
      || (evidence.score !== undefined && !validJudgment({ score: evidence.score, reason: evidence.reason }))) return;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${key}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(evidence), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
