import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getGrayscaleTaskBoundSide,
  hydrateGrayscaleTaskBinding,
  isGrayscaleTaskBindingValid,
  normalizeGrayscaleTaskBinding,
} from '../src/lib/grayscale/task-binding';

const task = { skillId: 'skill-1', skillVersionId: 'version-current' };

test('legacy A/B tasks keep B-side binding by default', () => {
  const config = hydrateGrayscaleTaskBinding({
    skillId: 'skill-1',
    versionAId: 'version-old',
    versionBId: 'version-current',
  }, task);

  assert.equal(getGrayscaleTaskBoundSide(config), 'b');
  assert.equal(isGrayscaleTaskBindingValid(config, task), true);
});

test('Skill workbench A/B tasks may bind the current version on side A', () => {
  const config = hydrateGrayscaleTaskBinding({
    skillId: 'skill-1',
    boundSide: 'a',
    versionAId: 'version-current',
    versionBId: 'version-old',
  }, task);

  assert.equal(getGrayscaleTaskBoundSide(config), 'a');
  assert.equal(isGrayscaleTaskBindingValid(config, task), true);
  assert.equal(config.versionBId, 'version-old');
});

test('hydration preserves an invalid explicit binding so validation can reject it', () => {
  const config = hydrateGrayscaleTaskBinding({
    skillId: 'skill-1',
    boundSide: 'a',
    versionAId: 'version-other',
    versionBId: 'version-old',
  }, task);

  assert.equal(config.versionAId, 'version-other');
  assert.equal(isGrayscaleTaskBindingValid(config, task), false);
});

test('normalization repairs only the configured bound side', () => {
  const config = normalizeGrayscaleTaskBinding({
    skillId: 'wrong-skill',
    boundSide: 'a',
    versionAId: 'wrong-version',
    versionBId: 'version-old',
  }, task);

  assert.equal(config.skillId, 'skill-1');
  assert.equal(config.versionAId, 'version-current');
  assert.equal(config.versionBId, 'version-old');
});
