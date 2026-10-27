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
import { goalPlusCurrentRunIds } from '@/lib/ingest/goal-plus/trace-scope';

test('Goal Plus run membership uses explicit IDs, never prompt text or all historical runs', () => {
  assert.deepEqual(goalPlusCurrentRunIds('[{"runId":"run-a"},{"runId":"run-a"},{"runId":"run-b"}]'), ['run-a', 'run-b']);
  for (const input of [null, '{', '{}', '[]', '[{"description":"run-a"}]']) assert.deepEqual(goalPlusCurrentRunIds(input), []);
});
import test from 'node:test';

import {
  goalPlusActiveMainSessionIdentities,
  goalPlusCodexExecutionId,
  goalPlusFrameworkForHost,
} from '@/lib/ingest/goal-plus/correlate';

test('Goal Plus derives the existing Codex execution identity without changing it', () => {
  assert.equal(goalPlusCodexExecutionId({
    codexConversationId: 'conversation-a',
    codexTurnId: 'turn-a',
  }), 'conversation-a:turn:turn-a');
  assert.equal(goalPlusCodexExecutionId({
    codexExecutionId: 'conversation-b:turn:turn-b',
    codexConversationId: 'ignored',
    codexTurnId: 'ignored',
  }), 'conversation-b:turn:turn-b');
  assert.equal(goalPlusCodexExecutionId({ codexConversationId: 'conversation-only' }), undefined);
});

test('Goal Plus correlation scopes native identities to their real framework', () => {
  assert.equal(goalPlusFrameworkForHost('pi-rpc'), 'pi-agent');
  assert.equal(goalPlusFrameworkForHost('pi'), 'pi-agent');
  assert.equal(goalPlusFrameworkForHost('codex'), 'codex');
  assert.equal(goalPlusFrameworkForHost('unknown'), undefined);
});

test('Goal Plus selects the discovered canonical main that matches the active native session', () => {
  const identities = goalPlusActiveMainSessionIdentities({
    host: 'pi-rpc',
    sessionId: 'native-current',
    mainSessions: [
      { host: 'pi', sessionId: 'canonical-old', nativeSessionId: 'native-old' },
      { host: 'pi', sessionId: 'canonical-current', nativeSessionId: 'native-current' },
    ],
  });

  assert.equal(identities.length, 1);
  assert.deepEqual(identities[0].exactIds, ['native-current', 'canonical-current']);
  assert.equal(identities[0].session.sessionId, 'canonical-current');
});

test('Goal Plus keeps active main identity ambiguous when multiple canonical sessions claim it', () => {
  const identities = goalPlusActiveMainSessionIdentities({
    sessionId: 'native-current',
    mainSessions: [
      { sessionId: 'canonical-a', nativeSessionId: 'native-current' },
      { sessionId: 'canonical-b', nativeSessionId: 'native-current' },
    ],
  });

  assert.equal(identities.length, 2);
  assert.deepEqual(identities.map(identity => identity.exactIds), [
    ['native-current', 'canonical-a'],
    ['native-current', 'canonical-b'],
  ]);
});
