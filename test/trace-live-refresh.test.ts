import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

test('trace and Goal Plus pages refresh while the browser tab is visible', () => {
  const tracePage = read('src/app/(main)/trace/page.tsx');
  const goalList = read('src/app/(main)/goal-plus/page.tsx');
  const goalDetail = read('src/app/(main)/goal-plus/[goalId]/page.tsx');

  for (const source of [tracePage, goalList, goalDetail]) {
    assert.match(source, /document\.visibilityState === ['"]visible['"]/);
    assert.match(source, /window\.setInterval\(refreshWhenVisible,/);
    assert.match(source, /document\.addEventListener\(['"]visibilitychange['"], refreshWhenVisible\)/);
    assert.match(source, /document\.removeEventListener\(['"]visibilitychange['"], refreshWhenVisible\)/);
  }
  assert.match(tracePage, /cache: ['"]no-store['"]/);
  assert.match(goalList, /GOAL_PLUS_REFRESH_MS = 5_000/);
  assert.match(goalDetail, /GOAL_PLUS_REFRESH_MS = 5_000/);
});

test('TraceDrawer silently refreshes an open trace and keeps its tree identity stable', () => {
  const drawer = read('src/components/observe/TraceDrawer.tsx');
  const traceView = read('src/components/observe/AgentTraceView.tsx');

  assert.match(drawer, /TRACE_DRAWER_REFRESH_MS = 5_000/);
  assert.match(drawer, /window\.setInterval\(refreshWhenVisible, TRACE_DRAWER_REFRESH_MS\)/);
  assert.match(drawer, /key=\{taskId\}/);
  assert.match(drawer, /traceIdentity=\{taskId\}/);
  assert.match(traceView, /const sameStableTrace =/);
  assert.match(traceView, /incoming\._payloadDeferred && loaded && !loaded\._payloadDeferred/);
});
