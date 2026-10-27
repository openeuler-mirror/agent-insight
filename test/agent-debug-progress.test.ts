import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDiagnosisProgress, progressFile, readDiagnosisProgress } from '../src/lib/engine/agent-debug/progress-store';
import { createDiagnosisObserver } from '../src/lib/engine/agent-debug/progress-observer';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-progress-'));
const previousRoot = process.env.GENERAL_AGENT_WORKSPACE_ROOT;
before(() => { process.env.GENERAL_AGENT_WORKSPACE_ROOT = root; });
after(() => {
  if (previousRoot == null) delete process.env.GENERAL_AGENT_WORKSPACE_ROOT;
  else process.env.GENERAL_AGENT_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
const identity = (runId: string) => ({ user: 'test-user', executionId: 'trace-1', runId });
const event = (key: string) => ({ key, kind: 'task' as const, state: 'update' as const, title: '诊断更新', summary: '已有可核验的证据' });

test('progress persists before a final report, deduplicates, and isolates user / execution / rerun', () => {
  const id = identity('first');
  const writer = createDiagnosisProgress(id);
  writer.emit(event('one'));
  writer.emit(event('one'));
  writer.emit(event('two'));
  assert.deepEqual(readDiagnosisProgress(id)?.events.map(item => item.seq), [1, 2]);
  assert.equal(readDiagnosisProgress(identity('second')), null);
  assert.equal(readDiagnosisProgress({ ...id, user: 'someone-else' }), null);
  assert.equal(readDiagnosisProgress({ ...id, executionId: 'trace-2' }), null);
  const copy = writer.snapshot();
  copy.events.length = 0;
  assert.equal(writer.snapshot().events.length, 2);
});

test('progress storage is bounded, redacts common secrets, and tolerates write failure', () => {
  const writer = createDiagnosisProgress(identity('bounded'));
  for (let index = 0; index < 205; index++) writer.emit(event(String(index)));
  assert.equal(writer.snapshot().events.length, 200);
  assert.equal(writer.snapshot().events[0].seq, 6);
  assert.equal(writer.snapshot().truncated, true);
  writer.emit({ ...event('secret'), summary: 'token=private-token {"password":"private-password"} Bearer private-bearer' });
  assert.doesNotMatch(writer.snapshot().events.at(-1)!.summary, /private-/);
  const id = identity('unwritable');
  fs.mkdirSync(progressFile(id), { recursive: true });
  const broken = createDiagnosisProgress(id);
  assert.doesNotThrow(() => broken.emit(event('still-running')));
  assert.equal(broken.snapshot().unavailable, true);
  assert.equal(broken.snapshot().events.length, 1);
});

test('corrupt persisted progress degrades to unavailable without breaking report queries', () => {
  const id = identity('corrupt');
  const writer = createDiagnosisProgress(id);
  writer.emit(event('one'));
  fs.writeFileSync(progressFile(id), '{unfinished');
  assert.equal(readDiagnosisProgress(id)?.unavailable, true);
});

test('real tool completion reveals static module evidence before final output; repeated scans are idempotent', () => {
  const workspaceDir = path.join(root, 'observer');
  const progress = createDiagnosisProgress(identity('observer'));
  const observer = createDiagnosisObserver({ workspaceDir, progress, traceRefs: [{ traceStepIndex: 7, anchorId: 'node-7' }] });
  const tool = { name: 'bash', sessionID: 'session', callID: 'static', input: { command: 'python3 agentdebug_static.py' } };
  observer.handlers.onTool?.({ ...tool, phase: 'start' });
  assert.equal(progress.snapshot().events.length, 1);
  assert.equal(progress.snapshot().events[0].state, 'started');
  observer.handlers.onTool?.({ ...tool, phase: 'delta', output: 'sensitive output' });
  assert.equal(progress.snapshot().events.length, 1);
  const artifact = path.join(workspaceDir, '.agent-insight', 'agent-debug-static.json');
  fs.writeFileSync(artifact, '{unfinished');
  observer.scan();
  assert.equal(progress.snapshot().events.length, 1);
  fs.writeFileSync(artifact, JSON.stringify({ stepRecords: [], phase1Grid: [], issues: [
    { module: 'action', traceStepIndex: 7, anchorId: 'untrusted-anchor', evidence: '工具调用返回权限错误' },
    { module: 'system', traceStepIndex: 999, evidence: '环境拒绝访问' },
  ] }));
  observer.handlers.onTool?.({ ...tool, phase: 'end' });
  const events = progress.snapshot().events;
  assert.deepEqual(events.filter(item => item.module).map(item => item.module), ['action', 'system']);
  assert.deepEqual(events.find(item => item.module === 'action')?.refs, [{ traceStepIndex: 7, anchorId: 'node-7' }]);
  assert.deepEqual(events.find(item => item.module === 'system')?.refs, []);
  assert.equal(fs.existsSync(path.join(workspaceDir, '.agent-insight', 'agent-debug-final.json')), false);
  observer.handlers.onTool?.({ ...tool, phase: 'end' });
  observer.scan();
  assert.equal(progress.snapshot().events.length, events.length);
});

test('structured module summaries arrive incrementally, reject old runs, and wait for complete lines', () => {
  const workspaceDir = path.join(root, 'summaries');
  const progress = createDiagnosisProgress(identity('summaries'));
  const observer = createDiagnosisObserver({ workspaceDir, progress, traceRefs: [{ traceStepIndex: 2, anchorId: 'two' }] });
  const file = path.join(workspaceDir, '.agent-insight', 'agent-debug-progress.jsonl');
  const summary = { runId: 'summaries', module: 'planning', state: 'update', title: '路径核验', summary: '已核验计划中的目标路径', steps: [2, 2, 888] };
  fs.writeFileSync(file, JSON.stringify({ ...summary, runId: 'old' }) + '\n' + JSON.stringify(summary));
  observer.scan();
  assert.equal(progress.snapshot().events.length, 0);
  fs.appendFileSync(file, '\n');
  observer.scan();
  assert.equal(progress.snapshot().events.length, 1);
  assert.deepEqual(progress.snapshot().events[0].refs, [{ traceStepIndex: 2, anchorId: 'two' }]);
  fs.appendFileSync(file, JSON.stringify({ ...summary, state: 'completed', summary: '本轮核验完成，等待最终归因' }) + '\n');
  observer.scan();
  assert.equal(progress.snapshot().events.length, 2);
  observer.scan();
  assert.equal(progress.snapshot().events.length, 2);
});

test('the Skill progress helper writes a current-run summary and fails nonfatally without context', () => {
  const workspaceDir = path.join(root, 'helper');
  const progress = createDiagnosisProgress(identity('helper'));
  const observer = createDiagnosisObserver({ workspaceDir, progress, traceRefs: [] });
  const script = path.resolve('skills/agent-debug-diagnosis/scripts/agentdebug_progress.py');
  const args = [script, '--module', 'memory', '--title', '证据范围', '--summary', '当前未找到足够的记忆证据'];
  assert.equal(spawnSync('python3', args, { cwd: workspaceDir }).status, 0);
  observer.scan();
  assert.equal(progress.snapshot().events[0].module, 'memory');
  assert.equal(spawnSync('python3', args, { cwd: root }).status, 0);
});

test('core conclusions complete only reviewed modules; records alone remain evidence', () => {
  const workspaceDir = path.join(root, 'core');
  const progress = createDiagnosisProgress(identity('core'));
  const observer = createDiagnosisObserver({ workspaceDir, progress, traceRefs: [] });
  fs.writeFileSync(path.join(workspaceDir, '.agent-insight/agent-debug-core.json'), JSON.stringify({
    stepRecords: [{ modules: { memory: { content: '原任务的上下文记录' } } }],
    phase1Grid: [{ module: 'planning', errorDetected: false, errorType: 'no_error' }],
    issues: [{ module: 'action', evidence: '调用失败' }],
  }));
  observer.scan();
  const events = progress.snapshot().events.filter(item => item.module);
  assert.deepEqual(events.map(item => [item.module, item.kind, item.state]), [
    ['memory', 'evidence', 'update'], ['planning', 'analysis', 'completed'], ['action', 'analysis', 'completed'],
  ]);
  observer.scan();
  assert.equal(progress.snapshot().events.filter(item => item.module).length, 3);
});

test('overall progress stays at task level and never starts System or other modules', () => {
  const workspaceDir = path.join(root, 'overall');
  const progress = createDiagnosisProgress(identity('overall'));
  const observer = createDiagnosisObserver({ workspaceDir, progress, traceRefs: [] });
  const script = path.resolve('skills/agent-debug-diagnosis/scripts/agentdebug_progress.py');
  const result = spawnSync('python3', [script, '--module', 'overall', '--state', 'started', '--title', '开始五模块诊断', '--summary', '已获取全局资料'], { cwd: workspaceDir });
  assert.equal(result.status, 0);
  observer.scan();
  assert.equal(progress.snapshot().events[0].module, undefined);
  assert.equal(progress.snapshot().events[0].kind, 'stage');
  assert.equal(progress.snapshot().events[0].state, 'started');
});
