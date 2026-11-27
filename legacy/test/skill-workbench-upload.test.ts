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
  SkillSnapshotUploadError,
  normalizeUploadPath,
  parseUploadedSkillSnapshot,
} from '../src/lib/skill-workbench/upload-service';

test('上传解析以唯一 SKILL.md 所在目录为根并保留文本文件', async () => {
  const skill = new File([
    '---\nname: sample-skill\ndescription: Sample\n---\n\n# Instructions',
  ], 'SKILL.md', { type: 'text/markdown' });
  const reference = new File(['reference content'], 'guide.md', { type: 'text/markdown' });
  const result = await parseUploadedSkillSnapshot(
    [skill, reference],
    ['sample/SKILL.md', 'sample/references/guide.md'],
  );

  assert.equal(result.skillName, 'sample-skill');
  assert.deepEqual(Object.keys(result.files).sort(), ['SKILL.md', 'references/guide.md']);
});

test('上传解析拒绝路径穿越', () => {
  assert.throws(() => normalizeUploadPath('../SKILL.md'), SkillSnapshotUploadError);
  assert.throws(() => normalizeUploadPath('/tmp/SKILL.md'), SkillSnapshotUploadError);
});

test('上传解析拒绝二进制文件，避免损坏候选快照', async () => {
  const skill = new File(['---\nname: sample\n---\n'], 'SKILL.md');
  const binary = new File([new Uint8Array([0, 1, 2])], 'asset.bin');
  await assert.rejects(
    parseUploadedSkillSnapshot([skill, binary], ['sample/SKILL.md', 'sample/asset.bin']),
    SkillSnapshotUploadError,
  );
});
