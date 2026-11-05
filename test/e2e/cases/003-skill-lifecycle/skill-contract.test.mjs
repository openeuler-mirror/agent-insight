import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as contract from './skill-contract.mjs';

test('fixed reference calculates real log facts and reports missing files without changing input', () => {
  assert.equal(typeof contract.referenceScript, 'string');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-contract-'));
  try {
    const file = path.join(root, 'count.py');fs.writeFileSync(file, contract.referenceScript);
    const input = path.resolve('public/example/messages');const original = fs.readFileSync(input);
    const run = spawnSync(process.env.E2E_PYTHON || '/opt/homebrew/bin/python3', [file, input], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);const stats = JSON.parse(run.stdout);
    assert.equal(stats.root_ssh_failures, 351);assert.equal(stats.top_source, '150.183.249.110');assert.equal(stats.top_source_failures, 80);assert.ok(stats.evidence[0].includes('authentication failure;'));
    assert.deepEqual(fs.readFileSync(input), original);
    const missing = spawnSync(process.env.E2E_PYTHON || '/opt/homebrew/bin/python3', [file, path.join(root, 'missing')], { encoding: 'utf8' });assert.equal(missing.status, 3);assert.ok(!missing.stderr.includes('Traceback'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('generated baseline stays two files and keeps the exact reference script', () => {
  assert.equal(typeof contract.assertControlledSnapshot, 'function');
  const files = { 'SKILL.md': '---\nname: example\n---\n# Example', 'scripts/count_root_ssh.py': contract.referenceScript };
  assert.doesNotThrow(() => contract.assertControlledSnapshot(files, 'example'));
  assert.throws(() => contract.assertControlledSnapshot({ ...files, 'scripts/extra.py': 'gzip' }, 'example'));
  assert.throws(() => contract.assertControlledSnapshot({ ...files, 'scripts/count_root_ssh.py': 'print(351)' }, 'example'));
  assert.throws(() => contract.assertControlledSnapshot(files, 'another'));
});

test('static assessment completion is separate from advisory quality and does not hide errors', () => {
  assert.equal(typeof contract.assertStaticAssessment, 'function');
  const report = { gate: { state: 'blocked' }, evaluation: { id: 'evaluation', status: 'ok', scores: { scores: { security: 5 } }, issues: [{ severity: 'high', evidence: 'scope note' }] } };
  assert.equal(contract.assertStaticAssessment(report).qualityPassed, false);
  assert.throws(() => contract.assertStaticAssessment({ ...report, evaluation: { ...report.evaluation, status: 'failed' } }));
  assert.throws(() => contract.assertStaticAssessment({ ...report, evaluation: null }));
});
test('optimization permits changed implementation only when independent log facts remain correct and input is unchanged',()=>{
 const files={'SKILL.md':'---\nname: example\n---\nE2E-SUMMARY', 'scripts/count_root_ssh.py':contract.referenceScript.replace('"root_ssh_failures": sum(counts.values()),','"root_ssh_failures": sum(counts.values()),\n        "diagnostic": len(evidence),')};
 assert.equal(typeof contract.assertOptimizedSnapshot,'function');const evidence=contract.assertOptimizedSnapshot(files,'example',path.resolve('public/example/messages'));assert.equal(evidence.original.root_ssh_failures,351);assert.equal(evidence.doubled.root_ssh_failures,702);
 assert.throws(()=>contract.assertOptimizedSnapshot({...files,'scripts/count_root_ssh.py':`print('{"root_ssh_failures":351,"top_source":"150.183.249.110","top_source_failures":80,"evidence":[]}')`},'example',path.resolve('public/example/messages')));
 assert.throws(()=>contract.assertOptimizedSnapshot({...files,'SKILL.md':'---\nname: example\n---\nNo summary'},'example',path.resolve('public/example/messages')));
});
test('structured evidence must identify the actual input file, line number and exact log text',()=>{
 const expression='"evidence": [line for host, line in evidence if host == address][:3],';
 const script=contract.referenceScript.replace(expression,'"evidence": [{"file":filename,"line":list(open(filename,encoding="utf-8")).index(line+"\\n")+1,"text":line} for host,line in evidence if host==address][:3],');
 const files={'SKILL.md':'---\nname: example\n---\nE2E-SUMMARY','scripts/count_root_ssh.py':script};assert.doesNotThrow(()=>contract.assertOptimizedSnapshot(files,'example',path.resolve('public/example/messages')));
 assert.throws(()=>contract.assertOptimizedSnapshot({...files,'scripts/count_root_ssh.py':script.replace('"file":filename','"file":"invented.log"')},'example',path.resolve('public/example/messages')));
 assert.throws(()=>contract.assertOptimizedSnapshot({...files,'scripts/count_root_ssh.py':contract.referenceScript.replace('"root_ssh_failures": sum(counts.values()),','"root_ssh_failures": 351,')},'example',path.resolve('public/example/messages')),e=>e.actual===351&&e.expected===702);
});
