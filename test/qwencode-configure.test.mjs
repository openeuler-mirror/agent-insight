import assert from 'node:assert/strict';
import test from 'node:test';

import { removeLegacyCollectorHooks } from '../scripts/qwencode-collector/configure.mjs';

test('QwenCode native telemetry migration preserves user settings while removing legacy collector hooks', () => {
  const input = {
    ui: { autoModeAcknowledged: true },
    hooks: {
      Stop: [{ matcher: '*', hooks: [
        { type: 'command', command: 'node user-hook.mjs', name: 'user-stop' },
        { type: 'command', command: 'node "D:\\old\\qwencode-collector\\index.mjs"', name: 'agent-insight-qwencode-stop' },
      ] }],
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node legacy.mjs', name: 'agent-insight-qwencode-session-start' }] }],
    },
  };
  const migrated = removeLegacyCollectorHooks(input);

  assert.equal(migrated.ui.autoModeAcknowledged, true);
  assert.equal(migrated.hooks.Stop.length, 1);
  assert.equal(migrated.hooks.Stop[0].hooks[0].name, 'user-stop');
  assert.equal(migrated.hooks.SessionStart, undefined);
});
