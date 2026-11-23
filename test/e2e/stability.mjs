import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { requiredStagesFor, scenarioResult, assertRunRoot, renderNpmResult } from './shared/core.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const stage = (report, id) => report.scenarios.find(s => s.id === 'CORE-E2E-003').stages.find(s => s.id === id);

export function assessStability(reports, typeProof = null) {
  assert.ok(reports.length >= 2, 'At least two independent real runs are required');
  const first = reports[0];const users = new Set(), databases = new Set(), taskIds = new Set(), ids = new Set();
  const rows = reports.map(report => {
    assert.equal(report.mode, 'real');assert.equal(report.selectedCase, '003');assert.ok(report.endedAt);
    assert.ok(!ids.has(report.runId));ids.add(report.runId);
    const scenario = report.scenarios.find(s => s.id === 'CORE-E2E-003');assert.equal(scenario.status, 'PASS');assert.equal(scenarioResult(scenario.stages, '003').status, 'PASS');
    assert.equal(scenario.stages.length, requiredStagesFor('003').length);
    assert.deepEqual(report.testBundleHashes, first.testBundleHashes, 'Test code changed between runs');assert.deepEqual(report.fixtureHashes, first.fixtureHashes);
    assert.equal(report.testedSha, first.testedSha);assert.equal(stage(report, 'model').actual.model, stage(first, 'model').actual.model);
    assert.equal(stage(report, 'ordinary-client').actual.version, stage(first, 'ordinary-client').actual.version);
    for (const [file, digest] of Object.entries(first.productSourceHashes)) {
      if (report.productSourceHashes[file] === digest) continue;
      assert.ok(typeProof?.file === file && typeProof.beforeSourceHash === digest && typeProof.afterSourceHash === report.productSourceHashes[file], 'Product implementation changed between runs');
      assert.equal(hash(typeProof.beforeSource), typeProof.beforeSourceHash);assert.equal(hash(typeProof.afterSource), typeProof.afterSourceHash);
      const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      assert.equal(compile(typeProof.beforeSource), compile(typeProof.afterSource), 'The type correction changed runtime JavaScript');
    }
    const user = stage(report, 'login').actual.username, database = stage(report, 'application').actual.database;
    assert.ok(!users.has(user) && !databases.has(database), 'Runs reused an account or database');users.add(user);databases.add(database);
    const scores = {};
    for (const id of ['baseline', 'candidate', 'published-run']) {
      const actual = stage(report, id).actual;assert.ok(actual.taskId && !taskIds.has(actual.taskId), 'A native session was reused');taskIds.add(actual.taskId);
      assert.ok(actual.score >= 80);scores[id] = actual.score;
    }
    assert.deepEqual(stage(report, 'cleanup').actual.remaining, []);
    return { runId: report.runId, status: 'PASS', stagesPassed: scenario.stages.length, seconds: Math.round((Date.parse(report.endedAt) - Date.parse(report.startedAt)) / 1000), scores, staticQualityPassed: stage(report, 'static').actual.qualityPassed, comparison: stage(report, 'candidate').actual.platformVerification || null };
  });
  return { scenario: 'CORE-E2E-003', status: 'PASS', consecutiveRuns: rows.length, independentAccounts: users.size, independentDatabases: databases.size, distinctBusinessTraces: taskIds.size, sameTestCode: true, sameBusinessRuntime: true, sameFixture: true, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'out-dir': { type: 'string' }, 'type-proof': { type: 'string' }, 'npm-result': { type: 'string' } } });
  assert.ok(values['out-dir']);const out = path.resolve(values['out-dir']);assertRunRoot(project, out);assert.ok(!fs.existsSync(out), 'Do not overwrite an earlier stability report');
  const roots = positionals.map(root => path.resolve(root));for (const root of roots) assertRunRoot(project, root);
  const reports = roots.map(root => JSON.parse(fs.readFileSync(path.join(root, 'report.json'))));
  const proof = values['type-proof'] ? JSON.parse(fs.readFileSync(values['type-proof'])) : null;
  const result = assessStability(reports, proof);
  for (const root of roots) {
    const file = path.join(root, 'ordinary/workspace/fixtures/messages');assert.equal(hash(fs.readFileSync(file)), '6d50cefa82380651f910df35fda0995a237a3c788b7b2e3d2d37e51fb9debca9');
    for (const label of ['baseline', 'candidate', 'published']) {
      const trace = JSON.parse(fs.readFileSync(path.join(root, `private/${label}-trace.json`)));
      const tools = trace.interactions.flatMap(m => m.tool_calls || []);
      assert.ok(tools.some(tool => {
        const args = String(tool.function?.arguments || tool.arguments || '');return args.includes('scripts/count_root_ssh.py') && args.includes(file);
      }), `${root}: ${label} did not actually execute the reference script on the selected file`);
    }
  }
  result.actualScriptExecutionsVerified = 3 * roots.length;result.scope = 'Two final real runs; prior development failures remain in their original run directories. PR Mock and CI triggering are not configured.';
  let npmSection = '';
  if (values['npm-result']) {
    result.npmTest = JSON.parse(fs.readFileSync(values['npm-result']));
    npmSection = renderNpmResult(result.npmTest);
  }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  const rows = result.rows.map(row => `<tr><td><a href="${row.runId}/report.html">${row.runId}</a></td><td>通过 ${row.stagesPassed}/14</td><td>${row.seconds} 秒</td><td>${row.scores.baseline} / ${row.scores.candidate} / ${row.scores['published-run']}</td><td>${row.staticQualityPassed ? '通过' : '存在意见，详见单轮报告'}</td></tr>`).join('');
  fs.writeFileSync(path.join(out, 'report.html'), `<!doctype html><html lang="zh"><meta charset="utf-8"><title>003 连续验证</title><style>body{font:15px system-ui;max-width:1100px;margin:32px auto;padding:0 20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:10px;text-align:left}</style><h1>003 Skill 生命周期：连续 ${result.consecutiveRuns} 轮通过</h1><p>相同业务运行逻辑与固定夹具，独立账号、数据库，${result.distinctBusinessTraces} 条不同的真实业务 Trace；每轮全部 14 阶段通过。</p><table><tr><th>运行</th><th>流程</th><th>用时</th><th>基线 / 候选 / 发布版评分</th><th>静态质量意见</th></tr>${rows}</table><p>每次都真实上传、生成、评估、实验、优化、发布及复跑，并核对实际加载、文件哈希、事实与 JSON、旧版保留和刷新重开。分数比较结论与固定业务验收条件分开保存。</p><p>这证明已观察到的两轮连续结果，未宣称无限次或离线模型稳定。此前失败不覆盖、不混入本轮通过。PR Mock、CI 触发与全量 npm test 不包含在此 E2E 结论中。</p>${npmSection}<p>报告由代码生成，不调用模型。<a href="report.json">结构化结果</a> · <a href="coverage.md">覆盖范围</a> · <a href="verification.json">验证记录</a></p></html>`);
  console.log('Stability report:', path.join(out, 'report.html'));
}
