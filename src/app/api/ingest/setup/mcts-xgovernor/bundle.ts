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

import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { runtimePackageRoot } from '@/lib/runtime/package-root';

const BUNDLE_FILES = [
  ['mcts-xgovernor-proxy/core.cjs', ['mcts-xgovernor-proxy', 'core.cjs']],
  ['mcts-xgovernor-proxy/gateway.cjs', ['mcts-xgovernor-proxy', 'gateway.cjs']],
  ['mcts-xgovernor-proxy/install.cjs', ['mcts-xgovernor-proxy', 'install.cjs']],
  ['mcts-xgovernor-proxy/mcts-config.cjs', ['..', '..', 'services', 'executor', 'src', 'mcts-config.cjs']],
  ['mcts-xgovernor-proxy/mcts-failure.cjs', ['..', '..', 'services', 'executor', 'src', 'mcts-failure.cjs']],
  ['mcts-xgovernor-proxy/run.cjs', ['mcts-xgovernor-proxy', 'run.cjs']],
  ['shared/collaboration-transport.cjs', ['shared', 'collaboration-transport.cjs']],
  ['shared/trace-transport.cjs', ['shared', 'trace-transport.cjs']],
] as const;

const ZIP_TIMESTAMP = new Date(1980, 0, 1, 0, 0, 0);
let cached: { root: string; sourceDigest: string; buffer: Buffer; sha256: string } | undefined;

export function mctsXgovernorCollectorBundle(root = runtimePackageRoot()) {
  const collectorRoot = path.join(root, 'scripts', 'agent-trace-collectors');
  const sources = BUNDLE_FILES.map(([archivePath, sourceParts]) => {
    const sourcePath = path.join(collectorRoot, ...sourceParts);
    const stat = lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Invalid MCTS xGovernor bundle source: ${archivePath}`);
    }
    return { archivePath, content: readFileSync(sourcePath) };
  });
  const digest = createHash('sha256');
  for (const source of sources) {
    digest.update(source.archivePath).update('\0').update(source.content).update('\0');
  }
  const sourceDigest = digest.digest('hex');
  if (cached?.root === root && cached.sourceDigest === sourceDigest) return cached;
  const archive = new AdmZip();
  for (const source of sources) {
    const entry = archive.addFile(source.archivePath, source.content);
    entry.header.time = ZIP_TIMESTAMP;
  }
  const buffer = archive.toBuffer();
  cached = {
    root,
    sourceDigest,
    buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
  return cached;
}
