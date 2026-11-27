import assert from 'node:assert/strict';
import test from 'node:test';
import { diffHarnessRequestMembership } from '../src/lib/ingest/deepseek-harness-otel/context-membership';

const item = (id: string, fingerprint?: string) => ({ id, fingerprint, category: 'user' });

test('Harness context comparison distinguishes changes from unknown content and incomplete membership', () => {
  const a = item('original', 'a');
  const b = item('summary', 'b');
  const oldTool = item('tool', 'one');
  const newTool = item('tool', 'two');
  const unknown = item('unknown');
  const previous = { complete: true, items: [a, oldTool, unknown] };
  const current = { complete: true, items: [b, newTool, unknown] };
  assert.deepEqual(diffHarnessRequestMembership(previous, current), {
    status: 'complete', added: [b], removed: [a], changed: [newTool], unknownChanges: 1,
  });
  assert.deepEqual(diffHarnessRequestMembership(previous, { ...current, complete: false }), {
    status: 'partial', added: [b], removed: null, changed: [newTool], unknownChanges: 1,
  });
  assert.deepEqual(diffHarnessRequestMembership(previous, { complete: true, items: [b, b] }), {
    status: 'ambiguous',
  });
});

test('Captured manifest adapter preserves exact member identities and refuses cross-session comparisons', async () => {
  const { diffCapturedHarnessRequests } = await import('../src/lib/ingest/deepseek-harness-otel/context-membership');
  const make = (items: any[]) => ({ schemaVersion: 1, sourceSessionId: 's', bindingStatus: 'bound', identityCoverage: 'stable', membershipCoverage: 'complete-at-capture-boundary', items });
  const a = { itemId: 'm', category: 'user', contentFingerprint: 'a' };
  const b = { ...a, contentFingerprint: 'b' };
  const c = { itemId: 'tool', category: 'tool', contentFingerprint: 'c' };
  const result = diffCapturedHarnessRequests(make([a]), make([b, c]));
  assert.equal(result.status, 'complete');
  assert.equal('added' in result && result.added?.length, 1);
  assert.equal('changed' in result && result.changed.length, 1);
  assert.equal(diffCapturedHarnessRequests(make([a]), { ...make([b]), sourceSessionId: 'child' }).status, 'incomparable');
  assert.equal(diffCapturedHarnessRequests(make([a]), { ...make([b]), bindingStatus: 'pending' }).status, 'incomparable');
});

test('Category summaries keep token estimates separate from source bytes and preserve missing history', async () => {
 const {summarizeHarnessContext,harnessDiffLimitation}=await import('../src/lib/ingest/deepseek-harness-otel/context-membership');
 const legacy={schemaVersion:1,items:[{category:'system',originalBytes:12},{category:'user',originalBytes:5}]};
 assert.equal(summarizeHarnessContext(null),null);
 assert.equal(summarizeHarnessContext(legacy)?.totalEstimatedTokens,null);
 const measured={...legacy,tokenEstimate:{method:'native',approximate:true,categories:{system:9,user:6}}};
 assert.equal(summarizeHarnessContext(measured)?.totalBytes,17);
 assert.equal(summarizeHarnessContext(measured)?.totalEstimatedTokens,15);
 assert.match(harnessDiffLimitation({status:'ambiguous'}),/标识重复/);
 assert.match(harnessDiffLimitation({status:'incomparable'}),/无法比较/);
 assert.match(harnessDiffLimitation({status:'partial'}),/不能视为零/);
 assert.match(harnessDiffLimitation(null),/前次成员记录缺失/);
});
