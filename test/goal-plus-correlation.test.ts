import assert from 'node:assert/strict';
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
