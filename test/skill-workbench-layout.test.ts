import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampCopilotWidth,
  COPILOT_MIN_WIDTH,
  WORKBENCH_DIVIDER_WIDTH,
  WORKSPACE_MIN_WIDTH,
} from '@/components/skill-workbench/workbench-layout';

test('workbench divider keeps both panes usable while allowing bidirectional resizing', () => {
  const availableWidth = 1600;
  const maxWidth = availableWidth - WORKSPACE_MIN_WIDTH - WORKBENCH_DIVIDER_WIDTH;

  assert.equal(clampCopilotWidth(100, availableWidth), COPILOT_MIN_WIDTH);
  assert.equal(clampCopilotWidth(520, availableWidth), 520);
  assert.equal(clampCopilotWidth(1400, availableWidth), maxWidth);
});

test('workbench divider falls back to the minimum copilot width on narrow screens', () => {
  assert.equal(clampCopilotWidth(520, 900), COPILOT_MIN_WIDTH);
});
