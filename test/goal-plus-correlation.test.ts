import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
