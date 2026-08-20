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
