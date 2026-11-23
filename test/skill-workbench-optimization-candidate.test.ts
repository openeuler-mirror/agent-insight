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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findCanonicalSkillMdPath,
  normalizeOptimizationCandidate,
} from '@/lib/skill-workbench/optimization-candidate';

test('optimization candidate excludes temporary nested skill trees', () => {
  const files = {
    '/workspace/SKILL.md': { content: 'root skill' },
    '/workspace/scripts/check.sh': { content: 'echo ok' },
    '/workspace/run-optimized-20260820/session/SKILL.md': { content: 'temporary copy' },
    '/workspace/run-optimized-20260820/session/references/note.md': { content: 'temporary note' },
  };

  assert.equal(findCanonicalSkillMdPath(files), '/workspace/SKILL.md');
  assert.deepEqual(normalizeOptimizationCandidate(files, '/workspace/SKILL.md'), {
    'SKILL.md': 'root skill',
    'scripts/check.sh': 'echo ok',
  });
});

test('optimization candidate strips the canonical skill root without whitelisting asset folders', () => {
  const files = {
    '/workspace/wrapped-skill/SKILL.md': { content: ['---', 'name: wrapped-skill', '---'] },
    '/workspace/wrapped-skill/assets/template.json': { content: '{"ok":true}' },
    '/workspace/wrapped-skill/.opencode/state.json': { content: '{}' },
  };

  assert.deepEqual(normalizeOptimizationCandidate(files), {
    'SKILL.md': '---\nname: wrapped-skill\n---',
    'assets/template.json': '{"ok":true}',
  });
});

test('nested skill roots do not discard unrelated files in a legitimate asset directory', () => {
  const files = {
    '/workspace/SKILL.md': { content: 'root skill' },
    '/workspace/references/guide.md': { content: 'keep me' },
    '/workspace/references/example-skill/SKILL.md': { content: 'nested package' },
    '/workspace/references/example-skill/scripts/run.sh': { content: 'echo nested' },
  };

  assert.deepEqual(normalizeOptimizationCandidate(files), {
    'SKILL.md': 'root skill',
    'references/guide.md': 'keep me',
  });
});
