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
