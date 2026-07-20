import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const inspectScript = path.join(
  process.cwd(),
  'skills/agent-debug-diagnosis/scripts/agentdebug_inspect.py',
);

test('agent-debug inspect searches full externalized artifacts with bounded output', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-debug-artifact-'));
  const insightDir = path.join(workspace, '.agent-insight');
  const traceDir = path.join(insightDir, 'trace');
  const artifactsDir = path.join(traceDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const artifactRelPath = '.agent-insight/trace/artifacts/node-1-output-0001.txt';
  fs.writeFileSync(
    path.join(workspace, artifactRelPath),
    `${'正常日志\n'.repeat(1000)}FAILED test_reload_config: AssertionError expected 0.5 got 1.8`,
  );
  fs.writeFileSync(path.join(traceDir, 'trace-index.json'), JSON.stringify({
    nodes: [{
      id: 'node-1',
      stepIndex: 12,
      name: '工具调用 · bash',
      outputArtifact: artifactRelPath,
    }],
  }));

  const inputPath = path.join(insightDir, 'agent-debug-input.json');
  fs.writeFileSync(inputPath, JSON.stringify({
    turns: [],
    traceBundle: { indexRelPath: '.agent-insight/trace/trace-index.json' },
  }));

  const output = execFileSync('python3', [
    inspectScript,
    'search',
    '--input', inputPath,
    '--scope', 'artifact',
    '--terms', 'FAILED,AssertionError',
  ], { encoding: 'utf8' });
  const result = JSON.parse(output);

  assert.equal(result.totalMatches, 1);
  assert.equal(result.matches[0].step, 12);
  assert.match(result.matches[0].snippet, /FAILED test_reload_config/);
  assert.ok(result.matches[0].snippet.length < 500);
  assert.ok(result.matches[0].artifactLength > 4000);
});
