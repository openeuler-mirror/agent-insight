import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { actionsConfiguration } from './actions-config.mjs';
import { compileProduction } from './build-preflight.mjs';
import { assertGitCodeGate } from './gitcode-gate.mjs';
import { sourceFingerprint, validateBuildArtifact, writeBuildManifest } from '../shared/build-artifact.mjs';
import { configSnapshot, caseMode, suiteMode, readModelKey, runDirectory } from '../shared/config.mjs';
import { cases } from '../shared/catalog.mjs';
import { scenarioResult, redact } from '../shared/core.mjs';
import { renderSummary, parseUtResult } from '../shared/suite.mjs';
import { boundedUtEnv } from '../shared/ut-environment.mjs';
import { command, stopCommands } from '../shared/runtime.mjs';
import { createActionsProcessScope } from '../shared/actions-process-cleanup.mjs';

const caseIds = cases.map(c => c.id);
const caseRunId = (runId, caseId) => `ag-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}-${caseId}`;
const activeKeyFiles = new Set();
const activeProcessScopes = new Set();
const inheritedNames = ['PATH','LANG','LC_ALL','TMPDIR','SYSTEMROOT','E2E_ISOLATED_CONTAINER','E2E_ATOMGIT_JOB','npm_config_cache','npm_config_offline','npm_config_registry','AGENT_INSIGHT_RAS_PYTHON','E2E_PYTHON','E2E_BROWSER_CHANNEL','E2E_NPM_REGISTRY','PLAYWRIGHT_BROWSERS_PATH','E2E_NPM_OFFLINE','E2E_PREPARED_PLUGIN_DIR','E2E_SKIP_TRACE_DATASET_CONCURRENCY_UT','PIP_NO_INDEX','PIP_FIND_LINKS'];
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o644 }); };
const message = error => redact(error instanceof Error ? error.message : 'Actions phase failed');
function system(bin, args) {
  const env = Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR','SYSTEMROOT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const result = spawnSync(bin, args, { encoding: 'utf8', env: { ...env, COPYFILE_DISABLE: '1' }, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  assert.equal(result.status, 0, `${bin} failed: ${String(result.stderr || result.error?.message || '').slice(0, 300)}`);
  return result.stdout;
}
function validateContext(context, options, checkSource = true) {
  assert.equal(context.version, 1, 'Unknown Actions artifact version');
  assert.equal(context.runId, options.runId, 'Actions run ID mismatch');
  assert.equal(context.testedSha, options.testedSha, 'Actions source SHA mismatch');
  assert.deepEqual(configSnapshot(context.configuration.settings), context.configuration, 'Actions configuration hash mismatch');
  assert.deepEqual(context.configuration.settings.cases, caseIds, 'All five E2E cases remain required');
  assert.equal(context.configuration.settings.runUt, true, 'Complete UT remains required');
  assert.deepEqual(context.configuration.settings.model.key, { fileEnv: 'E2E_MODEL_KEY_FILE' }, 'Invalid Actions credential reference');
  assert.match(context.sourceFingerprint, /^[a-f0-9]{64}$/);
  if (checkSource) {
    assert.equal(system('git', ['-C', options.project, 'rev-parse', 'HEAD']).trim(), options.testedSha, 'Checked out source SHA mismatch');
    assert.equal(system('git', ['-C', options.project, 'status', '--porcelain']).trim(), '', 'Actions source must match its commit');
    assert.equal(sourceFingerprint(options.project), context.sourceFingerprint, 'Compiled source fingerprint mismatch');
  }
  return context;
}
function baseEnvironment(options, context, name) {
  const env = Object.fromEntries(inheritedNames.filter(k => options.env[k] !== undefined).map(k => [k, options.env[k]]));
  const home = path.join(options.root, 'private', name);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  Object.assign(env, { HOME: path.join(home, 'home'), AGENT_INSIGHT_HOME: path.join(home, 'insight'), E2E_SUITE_RUN_ID: options.runId });
  Object.assign(env, options.processScopeEnv);
  fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  env.DATABASE_URL = 'file:' + path.join(env.AGENT_INSIGHT_HOME, 'data/witty_insight.db');
  env.AGENT_INSIGHT_TEST_DATABASE_URL = env.DATABASE_URL;
  if (context) Object.assign(env, { E2E_EXECUTION_CONFIG: JSON.stringify(context.configuration.settings), E2E_CONFIG_PROVENANCE: JSON.stringify(context.configuration), E2E_LANE: 'pr' });
  return env;
}
function exportBuild(project, directory, manifest) {
  fs.mkdirSync(directory, { recursive: true });
  const filter = source => {
    const relative = path.relative(project, source), name = path.basename(source);
    if (relative === '.next/cache' || relative.startsWith('.next/cache' + path.sep)) return false;
    if (/^\.env(?:\.|$)/.test(name) || /\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(name)) return false;
    return true;
  };
  for (const name of ['.next', 'generated']) {
    const source = path.join(project, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(directory, name), { recursive: true, dereference: true, filter });
  }
  writeBuildManifest(directory, manifest);
  validateBuildArtifact(directory, manifest.sourceFingerprint);
}
function unpack(archive, directory, maxBytes) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const script = `import pathlib,sys,tarfile\nroot=pathlib.Path(sys.argv[2]).resolve()\nlimit=int(sys.argv[3])\nwith tarfile.open(sys.argv[1],'r:gz') as archive:\n members=[]\n total=0\n for member in archive:\n  p=pathlib.PurePosixPath(member.name)\n  if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] not in ['.next','generated','manifest.json'] or not (member.isfile() or member.isdir()): raise ValueError('Unsafe compiled artifact member')\n  if any(part.startswith('.env') or part.endswith(('.db','.sqlite','.sqlite3')) for part in p.parts): raise ValueError('Sensitive compiled artifact member')\n  total+=member.size\n  if len(members)>=200000 or total>limit: raise ValueError('Compiled artifact exceeds workspace budget')\n  members.append(member)\n archive.extractall(root,members=members)\n`;
  system('python3', ['-c', script, archive, directory, String(maxBytes)]);
}
function importBuild(options, context) {
  validateContext(context, options);
  assert.match(context.payloadSha256, /^[a-f0-9]{64}$/);
  const archive = path.join(options.root, 'build-payload/compiled.tar.gz');
  assert.equal(hash(archive), context.payloadSha256, 'Compiled archive digest mismatch');
  const directory = fs.mkdtempSync(path.join(options.root, 'compiled-'));
  try {
    unpack(archive, directory, context.configuration.settings.resources.workspaceGiB * 1024 ** 3);
    const manifest = validateBuildArtifact(directory, context.sourceFingerprint);
    assert.equal(manifest.buildId, context.buildId, 'Compiled BUILD_ID differs from context');
    for (const name of ['.next', 'generated']) if (fs.existsSync(path.join(directory, name))) fs.cpSync(path.join(directory, name), path.join(options.project, name), { recursive: true });
    write(path.join(options.project, 'exclude/core-e2e/production-build.json'), { ...manifest, suiteRunId: options.runId });
    return manifest;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function emptyReport(options, context) {
  return { runId: options.runId, testedSha: options.testedSha, configuration: context?.configuration, mode: context ? suiteMode(context.configuration.settings) : 'mock', selected: caseIds, executionOrigin: 'atomgit-job', dirtyWorkingTree: false,
    account: context?.configuration.settings.account.username, startedAt: new Date().toISOString(), status: 'PARTIAL', npmTest: { status: 'NOT_RUN' }, scenarios: cases.map(c => ({ id: c.id, title: c.title, mode: context ? caseMode(context.configuration.settings, c.id) : 'mock', status: 'NOT_RUN', stages: [] })) };
}
function envelope(options, context, payload, status, exitCode = status === 'PASS' ? 0 : 1) {
  return { version: 1, phase: options.phase, ...(options.caseId ? { caseId: options.caseId } : {}), runId: options.runId, testedSha: options.testedSha, sourceFingerprint: context?.sourceFingerprint,
    configHash: context?.configuration.hash, buildId: context?.buildId || null, status, exitCode, endedAt: new Date().toISOString(), payload };
}
function failureDetails(ut) {
  return ut?.failures?.length ? '\n\n### UT 失败用例\n' + ut.failures.map(f => `- ${redact(f.file)}：${redact(f.title)}`).join('\n') : '';
}
function persist(options, context, result, report) {
  report.endedAt ||= new Date().toISOString();
  report.status = result.status;report.phase = options.phase;report.resultScope = options.phase === 'collect' ? 'workflow' : 'phase';
  if (['build','ut'].includes(options.phase)) delete report.selected;
  const secrets = [options.env.E2E_MODEL_API_KEY, ...Object.values(options.processScopeEnv || {})].filter(Boolean);
  const safeReport = JSON.parse(redact(JSON.stringify(report), secrets)), safeResult = JSON.parse(redact(JSON.stringify(result), secrets));
  const title = ({ build: '生产编译', ut: 'UT', case: 'E2E ' + options.caseId, collect: '汇总与门禁' })[options.phase];
  const scope = options.phase === 'collect' ? '本 Job 汇总生产编译、完整 UT 和五个 E2E Job，给出整体验证结论。' : `本 Job 仅表示${title}结果；整体验证结论见“汇总与门禁” Job。`;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const view = renderSummary(safeReport), markdownReport = JSON.parse(JSON.stringify(safeReport), (key, value) => typeof value === 'string' ? escape(value) : value);
  const diagnostics = [...new Set([safeReport.error, ...(safeReport.aggregationErrors || [])].filter(Boolean))];
  const diagnosticMarkdown = diagnostics.length ? '\n\n### 阻塞原因\n\n' + diagnostics.map(value => '- ' + escape(value).replace(/[\\`*_[\]|]/g, '\\$&').replace(/[\r\n]+/g, ' ')).join('\n') : '';
  const diagnosticHtml = diagnostics.length ? '<section><h2>阻塞原因</h2><ul>' + diagnostics.map(value => `<li>${escape(value)}</li>`).join('') + '</ul></section>' : '';
  const cleanup = safeReport.processCleanup;
  const cleanupSummary = cleanup ? `\n\nJob 进程清理：${cleanup.status}${cleanup.status === 'PASS' ? `；回收 ${cleanup.stopped} 个；剩余 ${cleanup.remaining} 个` : ''}\n` : '';
  const cleanupHtml = cleanup ? `<section><h2>Job 进程清理</h2><p>${escape(cleanup.status)}${cleanup.status === 'PASS' ? `；回收 ${cleanup.stopped} 个；剩余 ${cleanup.remaining} 个` : ''}</p></section>` : '';
  const cleanups = Object.entries(safeReport.processCleanups || {});
  const cleanupTable = cleanups.length ? '\n\n### Job 进程清理汇总\n\n| Job | 状态 | 回收数 | 剩余数 |\n|---|---|---|---|\n' + cleanups.map(([id, row]) => `| ${id} | ${row.status} | ${row.stopped ?? '—'} | ${row.remaining ?? '—'} |`).join('\n') + '\n' : '';
  const cleanupTableHtml = cleanups.length ? '<section><h2>Job 进程清理汇总</h2><table><tr><th>Job</th><th>状态</th><th>回收数</th><th>剩余数</th></tr>' + cleanups.map(([id, row]) => `<tr><td>${escape(id)}</td><td>${escape(row.status)}</td><td>${row.stopped ?? '—'}</td><td>${row.remaining ?? '—'}</td></tr>`).join('') + '</table></section>' : '';
  const summary = `## ${title}：${result.status}\n\n${scope}\n\n` + renderSummary(markdownReport).markdown + diagnosticMarkdown + failureDetails(markdownReport.npmTest) + cleanupSummary + cleanupTable + '\n';
  const html = view.html.replace('<h1>生产编译、UT 与 E2E</h1>', `<h1>Actions ${options.phase === 'collect' ? '汇总' : '阶段'}：${escape(title)}</h1><p>${escape(scope)}</p>`).replace('</html>', diagnosticHtml + cleanupHtml + cleanupTableHtml + '</html>');
  const directory = path.join(options.root, 'public');
  if (context) write(path.join(directory, 'context.json'), context);
  write(path.join(directory, 'result.json'), safeResult);write(path.join(directory, 'report.json'), safeReport);write(path.join(directory, 'report.html'), html);write(path.join(directory, 'summary.md'), summary);
  if (options.env.ATOMGIT_STEP_SUMMARY) fs.appendFileSync(options.env.ATOMGIT_STEP_SUMMARY, summary);
  console.log(`${title}: ${result.status}`);
  return safeResult;
}
async function buildPhase(options, dependencies) {
  const configuration = configSnapshot(actionsConfiguration({ event: options.env.E2E_ACTION_EVENT, env: options.env }));
  const context = { version: 1, runId: options.runId, testedSha: options.testedSha, sourceFingerprint: sourceFingerprint(options.project), configuration };
  validateContext(context, options);
  if (options.env.ATOMGIT_OUTPUT) fs.appendFileSync(options.env.ATOMGIT_OUTPUT, 'tested_sha=' + options.testedSha + '\n' + caseIds.map(id => `case_${id}_mode=${caseMode(configuration.settings, id)}\n`).join(''));
  write(path.join(options.root, 'build-payload/context.json'), context);
  const manifest = await dependencies.compile(configuration.settings, { project: options.project, runId: options.runId, env: baseEnvironment(options, context, 'build') });
  if (manifest.sourceFingerprint) assert.equal(manifest.sourceFingerprint, context.sourceFingerprint, 'Compilation source changed');
  manifest.sourceFingerprint = context.sourceFingerprint;
  assert.equal(sourceFingerprint(options.project), context.sourceFingerprint, 'Compilation changed source');
  const report = emptyReport(options, context);report.productionBuild = manifest;
  if (manifest.status === 'PASS') {
    context.buildId = manifest.buildId;
    const directory = path.join(options.root, 'compiled-export');exportBuild(options.project, directory, manifest);
    const archive = path.join(options.root, 'build-payload/compiled.tar.gz');
    system('tar', ['-czf', archive, '-C', directory, 'manifest.json', '.next', ...(fs.existsSync(path.join(directory, 'generated')) ? ['generated'] : [])]);
    context.payloadSha256 = hash(archive);fs.rmSync(directory, { recursive: true, force: true });
  } else report.status = manifest.status === 'FAIL' ? 'FAIL' : 'BLOCKED';
  write(path.join(options.root, 'build-payload/context.json'), context);
  return { context, result: envelope(options, context, manifest, manifest.status), report };
}
async function utPhase(options, context, dependencies) {
  const built = importBuild(options, context), config = context.configuration.settings;
  const env = baseEnvironment(options, context, 'ut'), log = path.join(options.root, 'private/npm-test.log');
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });fs.mkdirSync(path.join(env.AGENT_INSIGHT_HOME, 'data'), { recursive: true, mode: 0o700 });
  let ut;
  if (fs.existsSync(path.join(options.project, 'prisma/schema.prisma'))) {
    const initialized = await dependencies.run(process.execPath, ['node_modules/prisma/build/index.js','db','push','--skip-generate','--schema','prisma/schema.prisma'], { cwd: options.project, env, log, timeout: 120000 });
    if (initialized.code !== 0) ut = { status: 'BLOCKED', exitCode: initialized.code, fullSuiteComplete: false, interrupted: !!initialized.expired, reason: '隔离 UT 数据库初始化失败' };
    else {
      const legacy = path.join(options.project, 'data/witty_insight.db');fs.mkdirSync(path.dirname(legacy), { recursive: true });fs.copyFileSync(path.join(env.AGENT_INSIGHT_HOME, 'data/witty_insight.db'), legacy, fs.constants.COPYFILE_EXCL);
    }
  }
  const startedAt = new Date().toISOString();
  if (!ut) {
    const execution = await dependencies.run('npm', ['test'], { cwd: options.project, env: boundedUtEnv(options.root, env, config.timeouts.utFileMs, config.resources.cpus), log, timeout: config.timeouts.utMs });
    ut = { ...parseUtResult(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : execution.output || '', execution), fileTimeoutMs: config.timeouts.utFileMs };
  }
  Object.assign(ut, { startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt) });
  const report = emptyReport(options, context);report.productionBuild = built;report.npmTest = ut;if (ut.status !== 'PASS') report.status = ut.status;
  return { context, result: envelope(options, context, ut, ut.status, ut.exitCode ?? 1), report };
}
async function casePhase(options, context, dependencies) {
  assert.ok(caseIds.includes(options.caseId), 'Unknown Actions case');
  const built = importBuild(options, context), config = context.configuration.settings, mode = caseMode(config, options.caseId);
  const env = baseEnvironment(options, context, 'case'), childId = caseRunId(options.runId, options.caseId);
  const args = ['test/e2e/run-case.mjs','--case',options.caseId,'--run-id',childId];
  let keyFile;
  try {
    if (mode === 'real') {
      const key = readModelKey({ env: 'E2E_MODEL_API_KEY' }, options.env);
      keyFile = path.join(options.root, 'private/model.key');fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });activeKeyFiles.add(keyFile);args.push('--key-file', keyFile);
    }
    const execution = await dependencies.run(process.execPath, args, { cwd: options.project, env, log: path.join(options.root, 'private/case.log'), timeout: config.timeouts.caseMs, terminationGraceMs: config.timeouts.cleanupGraceMs });
    const child = read(path.join(runDirectory(options.project, config, childId), 'report.json'));
    assert.equal(child.runId, childId);assert.equal(child.testedSha, options.testedSha);assert.deepEqual(child.configuration, context.configuration);assert.equal(child.mode, mode);
    const current = child.scenarios.find(s => s.id === 'CORE-E2E-' + options.caseId);assert.ok(current, 'Missing scenario result');
    const payload = { ...current, id: options.caseId, title: cases.find(c => c.id === options.caseId).title, mode, startedAt: child.startedAt, endedAt: child.endedAt, durationMs: Date.parse(child.endedAt) - Date.parse(child.startedAt), runId: childId };
    let status = scenarioResult(payload.stages, options.caseId).status;
    if (current.status !== 'PASS' || execution.code !== 0 || execution.expired || execution.signal || child.interrupted || !child.endedAt) status = current.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL';
    payload.status = status;
    const report = emptyReport(options, context);report.productionBuild = built;report.selected = [options.caseId];report.scenarios[caseIds.indexOf(options.caseId)] = payload;if (status !== 'PASS') report.status = status;
    return { context, result: envelope(options, context, payload, status, execution.code), report };
  } finally { if (keyFile) { fs.rmSync(keyFile, { force: true });activeKeyFiles.delete(keyFile); } }
}
function matchingResult(options, context, id, cleanups) {
  const result = read(path.join(options.root, 'inputs', id, 'result.json'));
  assert.equal(result.version, 1);assert.equal(result.phase, caseIds.includes(id) ? 'case' : id);assert.equal(result.runId, options.runId);assert.equal(result.testedSha, options.testedSha);
  assert.equal(result.sourceFingerprint, context.sourceFingerprint);assert.equal(result.configHash, context.configuration.hash);assert.equal(result.buildId, context.buildId || null);
  assert.ok(Number.isFinite(Date.parse(result.endedAt)), 'Phase result is incomplete');if (caseIds.includes(id)) assert.equal(result.caseId, id);
  if (cleanups && result.processCleanup) cleanups[id] = {
    status: result.processCleanup.status === 'PASS' ? 'PASS' : 'BLOCKED',
    stopped: Number.isSafeInteger(result.processCleanup.stopped) && result.processCleanup.stopped >= 0 ? result.processCleanup.stopped : null,
    remaining: Number.isSafeInteger(result.processCleanup.remaining) && result.processCleanup.remaining >= 0 ? result.processCleanup.remaining : null,
  };
  if (options.env.E2E_ATOMGIT_JOB === '1') {
    assert.equal(result.processCleanup?.status, 'PASS', 'Job process cleanup did not complete');
    assert.equal(result.processCleanup.remaining, 0, 'Job process cleanup left owned processes');
    assert.ok(Number.isSafeInteger(result.processCleanup.stopped) && result.processCleanup.stopped >= 0, 'Invalid Job process cleanup result');
  }
  if (result.status === 'PASS') assert.equal(result.exitCode, 0, 'Successful phase has nonzero process exit');
  return result;
}
function collectPhase(options) {
  const context = validateContext(read(path.join(options.root, 'inputs/build/context.json')), options);
  const report = emptyReport(options, context), problems = [];report.processCleanups = {};
  let outcomes;
  try { outcomes = JSON.parse(options.env.E2E_JOB_RESULTS_JSON);assert.deepEqual(Object.keys(outcomes).sort(), ['build','ut',...caseIds].sort()); }
  catch { problems.push('Platform job outcomes are missing or malformed'); }
  for (const id of ['build','ut',...caseIds]) if (outcomes?.[id] !== 'success') problems.push(`${id}: platform outcome ${String(outcomes?.[id] || 'missing')}`);
  let build;
  try { build = matchingResult(options, context, 'build', report.processCleanups);report.productionBuild = build.payload;assert.equal(build.status, build.payload.status); }
  catch (error) { problems.push('build: ' + message(error));report.productionBuild = { status: 'BLOCKED', reason: problems.at(-1) }; }
  if (build?.status === 'PASS') {
    try { const ut = matchingResult(options, context, 'ut', report.processCleanups);assert.equal(ut.status, ut.payload.status);report.npmTest = ut.payload; }
    catch (error) { problems.push('ut: ' + message(error));report.npmTest = { status: 'BLOCKED', fullSuiteComplete: false, reason: problems.at(-1) }; }
    for (const id of caseIds) {
      try {
        const result = matchingResult(options, context, id, report.processCleanups), row = result.payload;
        assert.equal(row.id, id);assert.equal(row.runId, caseRunId(options.runId, id), 'Actions child run ID mismatch');assert.equal(row.mode, caseMode(context.configuration.settings, id));assert.equal(result.status, row.status);
        if (row.status === 'PASS') assert.equal(scenarioResult(row.stages, id).status, 'PASS', 'Required stages are incomplete');
        report.scenarios[caseIds.indexOf(id)] = row;
      } catch (error) { problems.push(id + ': ' + message(error));Object.assign(report.scenarios[caseIds.indexOf(id)], { status: 'BLOCKED', reason: problems.at(-1) }); }
    }
  } else {
    for (const row of report.scenarios) row.reason = '生产编译未通过，未执行该 E2E';
    problems.push('Production compilation did not pass');
  }
  const selected = report.scenarios;
  report.status = problems.length ? 'BLOCKED' : report.productionBuild.status === 'PASS' && report.npmTest.status === 'PASS' && selected.every(s => s.status === 'PASS') ? 'PASS' : 'FAIL';
  const started = [report.productionBuild?.startedAt, report.npmTest?.startedAt, ...selected.map(s => s.startedAt)].filter(Boolean).sort();if (started.length) report.startedAt = started[0];
  const caseStarts = selected.map(s => s.startedAt).filter(Boolean).sort(), caseEnds = selected.map(s => s.endedAt).filter(Boolean).sort();
  if (caseStarts.length && caseEnds.length) Object.assign(report, { e2eStartedAt: caseStarts[0], e2eEndedAt: caseEnds.at(-1), e2eDurationMs: Date.parse(caseEnds.at(-1)) - Date.parse(caseStarts[0]) });
  report.endedAt = new Date().toISOString();if (problems.length) report.aggregationErrors = problems;
  if (report.status === 'PASS') {
    try { assertGitCodeGate(report, { runId: options.runId, testedSha: options.testedSha, freshJob: true, expectedConfiguration: context.configuration }); }
    catch (error) { report.status = 'FAIL';report.aggregationErrors = [message(error)]; }
  }
  return { context, result: envelope(options, context, report, report.status), report };
}
export async function runActionsPhase(input, overrides = {}) {
  const options = { ...input, project: path.resolve(input.project), root: path.resolve(input.root), env: input.env || process.env };
  assert.ok(['build','ut','case','collect'].includes(options.phase));assert.match(options.runId, /^[a-z0-9-]{1,80}$/);assert.match(options.testedSha, /^[a-f0-9]{40}$/);
  const relativeRoot = path.relative(options.project, options.root);assert.ok(relativeRoot === '..' || relativeRoot.startsWith('..' + path.sep), 'Actions job root must be outside source');
  fs.mkdirSync(path.join(options.root, 'private'), { recursive: true, mode: 0o700 });fs.mkdirSync(path.join(options.root, 'public'), { recursive: true, mode: 0o755 });
  const dependencies = { compile: compileProduction, run: command, createProcessScope: createActionsProcessScope, ...overrides };
  let outcome, context, processScope;
  const progress = () => {
    const event = { phase: options.phase, caseId: options.caseId, status: 'RUNNING' };
    if (options.phase === 'case') {
      try { const partial = read(path.join(options.project, 'exclude/core-e2e', caseRunId(options.runId, options.caseId), 'report.json'));const stage = partial.scenarios.find(row => row.id === 'CORE-E2E-' + options.caseId)?.stages.at(-1);if (stage && /^[a-z0-9-]{1,80}$/.test(stage.id)) Object.assign(event, { stage: stage.id, stageStatus: stage.status }); } catch {}
    }
    console.log('CI_PHASE_PROGRESS', JSON.stringify(event));
  };
  progress();const timer = setInterval(progress, 30000);timer.unref();
  try {
    if (options.env.E2E_ATOMGIT_JOB === '1' && options.phase !== 'collect') {
      processScope = await dependencies.createProcessScope();
      options.processScopeEnv = processScope.env;
      activeProcessScopes.add(processScope);
    }
    if (options.phase === 'build') outcome = await buildPhase(options, dependencies);
    else if (options.phase === 'collect') outcome = collectPhase(options);
    else {
      context = read(path.join(options.root, 'build-payload/context.json'));
      outcome = options.phase === 'ut' ? await utPhase(options, context, dependencies) : await casePhase(options, context, dependencies);
    }
  } catch (error) {
    if (!context) {
      try { context = read(path.join(options.root, options.phase === 'collect' ? 'inputs/build/context.json' : 'build-payload/context.json')); } catch {}
    }
    try { if (context) validateContext(context, options, false); } catch { context = undefined; }
    const payload = { status: 'BLOCKED', reason: message(error) }, report = emptyReport(options, context);
    report.status = 'BLOCKED';report.error = payload.reason;
    if (options.phase === 'build') report.productionBuild = payload;
    if (options.phase === 'ut') report.npmTest = { ...payload, fullSuiteComplete: false };
    if (options.phase === 'case') Object.assign(report.scenarios.find(s => s.id === options.caseId) || {}, payload);
    outcome = { context, result: envelope(options, context, payload, 'BLOCKED'), report };
  } finally {
    if (processScope) {
      let cleanup;
      try {
        cleanup = await processScope.cleanup();
        assert.equal(cleanup.status, 'PASS');assert.equal(cleanup.remaining, 0);assert.ok(Number.isSafeInteger(cleanup.stopped) && cleanup.stopped >= 0);
        cleanup = { status: 'PASS', stopped: cleanup.stopped, remaining: 0 };
      } catch (error) {
        cleanup = { status: 'BLOCKED', reason: 'Job process cleanup failed: ' + message(error) };
        const reason = [outcome.result.payload.reason, cleanup.reason].filter(Boolean).join('; ');
        Object.assign(outcome.result, { status: 'BLOCKED', exitCode: 1 });
        Object.assign(outcome.result.payload, { status: 'BLOCKED', reason });
        outcome.report.error = reason;
      } finally { activeProcessScopes.delete(processScope); }
      outcome.result.processCleanup = cleanup;outcome.report.processCleanup = cleanup;
    }
    clearInterval(timer);
  }
  return persist(options, outcome.context, outcome.result, outcome.report);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;stopping = true;
    try { await stopCommands(); }
    finally {
      await Promise.allSettled([...activeProcessScopes].map(scope => scope.cleanup()));
      for (const file of activeKeyFiles) fs.rmSync(file, { force: true });process.exit(143);
    }
  };
  process.on('SIGTERM', stop);process.on('SIGINT', stop);
  try {
    const { values } = parseArgs({ options: { phase: { type: 'string' }, project: { type: 'string' }, root: { type: 'string' }, 'run-id': { type: 'string' }, 'tested-sha': { type: 'string' }, case: { type: 'string' } } });
    const result = await runActionsPhase({ phase: values.phase, project: values.project, root: values.root, runId: values['run-id'], testedSha: values['tested-sha'], caseId: values.case });
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) { console.error('Actions phase failed:', message(error));process.exitCode = 1; }
  finally { process.removeListener('SIGTERM', stop);process.removeListener('SIGINT', stop); }
}
