import assert from 'node:assert/strict';
import test from 'node:test';

import { MirroredDeltaGuard } from '../src/lib/engine/skill-generation/opencode-agent-cli/stream-event-dedupe';

test('MirroredDeltaGuard consumes the matching updated delta exactly once', () => {
  const guard = new MirroredDeltaGuard();
  guard.remember('message:part', '同一段文字');

  assert.equal(guard.consume('message:part', '同一段文字'), true);
  assert.equal(guard.consume('message:part', '同一段文字'), false);
});

test('MirroredDeltaGuard keeps unrelated and legitimately repeated deltas', () => {
  const guard = new MirroredDeltaGuard();
  guard.remember('message:part', '第一段');

  assert.equal(guard.consume('message:part', '第二段'), false);
  assert.equal(guard.consume('another:part', '第一段'), false);
});

test('MirroredDeltaGuard keeps every pending mirror when updated events arrive in a batch', () => {
  const guard = new MirroredDeltaGuard();
  guard.remember('message:part', '第一段');
  guard.remember('message:part', '第二段');
  guard.remember('message:part', '第三段');

  assert.equal(guard.consume('message:part', '第一段'), true);
  assert.equal(guard.consume('message:part', '第二段'), true);
  assert.equal(guard.consume('message:part', '第三段'), true);
  assert.equal(guard.consume('message:part', '第三段'), false);
});

test('MirroredDeltaGuard preserves legitimately repeated chunks one occurrence at a time', () => {
  const guard = new MirroredDeltaGuard();
  guard.remember('message:part', '同');
  guard.remember('message:part', '同');

  assert.equal(guard.consume('message:part', '同'), true);
  assert.equal(guard.consume('message:part', '同'), true);
  assert.equal(guard.consume('message:part', '同'), false);
});
