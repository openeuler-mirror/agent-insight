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
import path from 'node:path';

type RuntimeOwner = { version: 1; id: string; scope: string; fd: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function runtimeOwner(directory: string): RuntimeOwner | undefined {
  try {
    const value = JSON.parse(process.env.AGENT_INSIGHT_RUNTIME_OWNER || 'null') as RuntimeOwner | null;
    if (!value || value.version !== 1 || !UUID.test(value.id) || !path.isAbsolute(value.scope)
      || !Number.isSafeInteger(value.fd) || value.fd < 3) return;
    const held = fs.fstatSync(value.fd);
    const canonical = fs.lstatSync(path.join(value.scope, '.runtime-owner.lock'));
    if (!held.isFile() || !canonical.isFile() || held.dev !== canonical.dev || held.ino !== canonical.ino
      || held.size > 4096 || fs.realpathSync(value.scope) !== value.scope) return;
    const bytes = Buffer.alloc(4097);
    const count = fs.readSync(value.fd, bytes, 0, bytes.length, 0);
    const record = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (record.id !== value.id || record.scope !== value.scope) return;
    const relative = path.relative(value.scope, fs.realpathSync(directory));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    return value;
  } catch { return; }
}

export function runtimeLockDirectory(directory: string): string {
  const owner = runtimeOwner(directory);
  if (!owner) return directory;
  const base = path.join(fs.realpathSync(directory), '.runtime-owners');
  const current = path.join(base, owner.id);
  for (const target of [base, current]) {
    try { fs.mkdirSync(target, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(target).isDirectory() || fs.realpathSync(target) !== target) {
      throw new Error('Unsafe runtime ownership directory');
    }
  }
  return current;
}
