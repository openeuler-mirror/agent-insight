import assert from 'node:assert/strict';
import test from 'node:test';
import DiagnosisRunPage from '../src/app/(main)/diagnosis-runs/[runId]/page';

test('legacy diagnosis links reopen the same run in the diagnosis workspace', async () => {
  for (const runId of ['run-123', 'run/a?b=评测']) {
    await assert.rejects(DiagnosisRunPage({ params: Promise.resolve({ runId }) }), (error: unknown) => {
      const digest = (error as { digest: string }).digest;
      assert.equal(digest, `NEXT_REDIRECT;replace;/fault?runId=${encodeURIComponent(runId)};307;`);
      return true;
    });
  }
});
