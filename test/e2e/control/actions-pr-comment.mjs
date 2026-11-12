import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AtomGit } from './atomgit.mjs';
import { assertGitCodeGate } from './gitcode-gate.mjs';
import { cases } from '../shared/catalog.mjs';
import { redact, scenarioResult } from '../shared/core.mjs';

const workflowPath = '.atomgit/workflows/pr-e2e.yml';
const marker = 'agent-insight-actions-result:v1';
const stages = [['build', '生产编译'], ['ut', '完整 UT'], ...cases.map(c => ['case_' + c.id, c.id + ' ' + c.title]), ['collect', '汇总与门禁']];
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'IGNORED']);
const labels = { PASS: '通过', FAIL: '失败', BLOCKED: '阻塞', NOT_RUN: '未执行', PARTIAL: '不完整', CANCELED: '已取消', COMPLETED: '通过', FAILED: '失败', IGNORED: '未执行', RUNNING: '执行中' };
const canReport = pr => ['open', 'opened', 'merged'].includes(pr.state) || pr.state === 'closed' && !!pr.merged_at;
const catalogHash = createHash('sha256').update(JSON.stringify(cases.map(({ id, title }) => ({ id, title })))).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safe = (value, secrets = []) => redact(String(value ?? ''), secrets).slice(0, 500)
  .replace(/\b(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
  .replace(/[&<>@]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '@': '&#64;' })[c])
  .replace(/[\\`*_[\]{}|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const duration = (start, end) => Number.isFinite(start) && start > 0 && Number.isFinite(end) && end >= start ? ((end - start) / 1000).toFixed(1) + ' 秒' : '—';
const order = run => [run.run_number, run.attempt || 1, run.runStartedAt ?? run.start_time ?? 0];
const newer = (a, b) => order(a).some((value, i) => value > order(b)[i] && order(a).slice(0, i).every((v, j) => v === order(b)[j]));
function assertCurrentExecution(value, run) {
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) < run.start_time - 1000) throw Object.assign(Error('Evidence belongs to another execution'), { code: 'PR_REPORT_EXECUTION' });
}

export function decodeReportArchive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024) throw Error('Invalid report archive size');
  const script = `import io,json,sys,zipfile\nwith zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read(8388609))) as z:\n matches=[i for i in z.infolist() if i.filename=='report.json']\n if len(matches)!=1 or matches[0].file_size>1048576: raise ValueError('Invalid report member')\n with z.open(matches[0]) as f: data=f.read(1048577)\n if len(data)>1048576: raise ValueError('Report too large')\n value=json.loads(data)\n if not isinstance(value,dict): raise ValueError('Invalid report')\n sys.stdout.write(json.dumps(value))`;
  const result = spawnSync('python3', ['-c', script], { input: bytes, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 10_000, maxBuffer: 6 * 1024 * 1024 });
  if (result.status !== 0) throw Error('Invalid report archive or report.json');
  return JSON.parse(result.stdout);
}

async function list(api, route, key, apiVersion = 5) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const value = await api.request('GET', route + (route.includes('?') ? '&' : '?') + `per_page=100&page=${page}`, undefined, { apiVersion });
    const rows = key ? value?.[key] : value;
    if (!Array.isArray(rows)) throw Error('Invalid paginated API response');
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw Error('API pagination exceeds bounded scan window');
}

function boundRun(run, pr) {
  return run?.file_path === workflowPath && run.event === 'MR' && String(run.pull_request_id) === String(pr.number)
    && sha(run.head_sha) && run.head_sha === pr.head?.sha && /^[a-f0-9]{32}$/.test(run.workflow_run_id || '')
    && /^[a-f0-9]{32}$/.test(run.workflow_id || '') && Number.isSafeInteger(run.run_number) && run.run_number > 0;
}

async function loadReport(api, repository, run, jobs) {
  let checkpoint = '制品列表';
  try {
  const prefix = api.repoPath(repository);
  const artifacts = (await api.request('GET', `${prefix}/actions/runs/${run.workflow_run_id}/artifacts`, undefined, { apiVersion: 8 }))?.artifacts;
  if (!Array.isArray(artifacts)) throw Error('Invalid artifact list');
  const matches = artifacts.filter(a => a.name === 'pr-e2e');
  if (matches.length !== 1) throw Error('Final pr-e2e report missing or ambiguous');
  const artifact = matches[0];
  checkpoint = '制品所属执行';
  assertCurrentExecution(artifact.created_at, run);
  checkpoint = '制品元数据';
  assert.equal(artifact.workflow_run_id, run.workflow_run_id);assert.equal(artifact.workflow_id, run.workflow_id);
  assert.ok(Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes > 0 && artifact.size_bytes <= 8 * 1024 * 1024);
  assert.match(artifact.digest || '', /^sha256:[a-f0-9]{64}$/);
  checkpoint = '制品下载';
  const bytes = await api.downloadArtifact(repository, artifact.id);
  checkpoint = '制品摘要';
  assert.equal(bytes.length, artifact.size_bytes);assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), artifact.digest);
  checkpoint = '报告读取';
  const report = decodeReportArchive(bytes);
  checkpoint = '报告格式与阶段完整性';
  assert.equal(report.phase, 'collect');assert.equal(report.resultScope, 'workflow');assert.equal(report.executionOrigin, 'atomgit-job');
  assert.equal(report.runId, 'atomgit-' + run.workflow_run_id);assert.ok(sha(report.testedSha));
  assert.notEqual(report.dirtyWorkingTree, true);assert.ok(report.endedAt);
  assertCurrentExecution(report.startedAt, run);
  assert.deepEqual(report.scenarios?.map(c => c.id).sort(), cases.map(c => c.id));
  if (run.attempt > 1 && report.platformRunAttempt !== run.attempt) throw Object.assign(Error('Missing current attempt provenance'), { code: 'PR_REPORT_ATTEMPT' });
  if (report.platformRunAttempt !== undefined) assert.equal(report.platformRunAttempt, run.attempt);
  assert.ok(['PASS', 'FAIL', 'BLOCKED', 'PARTIAL'].includes(report.status));
  for (const row of report.scenarios) {
    assert.ok(row && ['PASS', 'FAIL', 'BLOCKED', 'PARTIAL', 'NOT_RUN'].includes(row.status));
    assert.ok(Array.isArray(row.stages));
    assert.ok(row.stages.every(stage => stage && typeof stage.id === 'string' && typeof stage.status === 'string'));
    for (const field of ['reason', 'firstProblem']) assert.ok(row[field] == null || typeof row[field] === 'string');
    if (row.status === 'PASS') assert.equal(scenarioResult(row.stages, row.id).status, 'PASS');
  }
  const ut = report.npmTest, counts = ut?.observedSummary;
  assert.ok(ut && typeof ut.status === 'string');
  assert.ok(ut.failures === undefined || Array.isArray(ut.failures) && ut.failures.every(f => f && typeof f.file === 'string' && typeof f.title === 'string'));
  assert.ok(report.aggregationErrors === undefined || Array.isArray(report.aggregationErrors) && report.aggregationErrors.every(e => typeof e === 'string'));
  if (ut.status === 'PASS') {
    assert.equal(ut.fullSuiteComplete, true);assert.notEqual(ut.interrupted, true);
    assert.ok(counts && ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0));
    assert.ok(counts.tests > 0 && counts.pass > 0 && counts.fail === 0 && counts.cancelled === 0 && counts.tests === counts.pass + counts.skipped + counts.todo);
  }
  if (report.productionBuild?.status === 'PASS') { assert.equal(report.productionBuild.exitCode, 0);assert.ok(typeof report.productionBuild.buildId === 'string' && report.productionBuild.buildId.trim()); }
  checkpoint = '阶段所属执行';
  const phaseRows = [['build', report.productionBuild], ['ut', report.npmTest], ...report.scenarios.map(c => ['case_' + c.id, c])];
  for (const [id, row] of phaseRows) {
    if (row?.status === 'PASS' || row?.startedAt !== undefined) assertCurrentExecution(row?.startedAt, run);
    if (row?.status === 'PASS') assert.notEqual(jobs.find(job => job.identifier === id)?.status, 'IGNORED');
  }
  checkpoint = '测试提交归属';
  const commit = await api.request('GET', prefix + '/commits/' + report.testedSha);
  assert.equal(commit.sha, report.testedSha);
  const testScope = report.testedSha === run.head_sha ? 'source' : 'merge';
  if (testScope === 'merge') { assert.equal(commit.parents?.length, 2);assert.equal(commit.parents[1].sha, run.head_sha);assert.ok(sha(commit.parents[0].sha)); }
  checkpoint = '完整门禁证据';
  if (report.status === 'PASS') assertGitCodeGate(report, { runId: report.runId, testedSha: report.testedSha, freshJob: true, expectedConfiguration: report.configuration });
  return { report, testScope, baseSha: testScope === 'merge' ? commit.parents[0].sha : undefined };
  } catch (error) { error.reportCheckpoint = checkpoint;throw error; }
}

export function renderPrResult({ repository, pr, run, jobs, report, baseSha, testScope, reportProblem, secrets = [] }) {
  const byId = new Map(jobs.map(job => [job.identifier, job]));
  const completeJobs = stages.every(([id]) => byId.get(id)?.status === 'COMPLETED');
  const status = run.status === 'CANCELED' ? 'CANCELED' : run.status === 'FAILED' || jobs.some(j => j.status === 'FAILED') || report?.status === 'FAIL' ? 'FAIL'
    : run.status === 'COMPLETED' && completeJobs && report?.status === 'PASS' && !reportProblem ? 'PASS' : 'BLOCKED';
  const metadata = { repository, pr: pr.number, runId: run.workflow_run_id, workflowId: run.workflow_id, run_number: run.run_number, attempt: run.attempt || 1, runStartedAt: run.start_time, headSha: run.head_sha, platformStatus: run.status, reportVerified: !!report && !reportProblem, catalogHash };
  const lines = [`<!-- ${marker} ${JSON.stringify(metadata)} -->`, `## PR 验证结果：${labels[status]}`, '', `源提交：\`${run.head_sha}\``, `测试提交：${report ? '`' + report.testedSha + '`' : '未取得可信报告'}`, ...(testScope ? [`测试范围：${testScope === 'source' ? '源提交（非预合并），不代表与当前 master 集成后的结果。' : '预合并提交'}`] : []), ...(baseSha ? [`本次测试基线：\`${baseSha}\``] : []), `运行：#${run.run_number} · 平台轮次 ${metadata.attempt} · ${duration(run.start_time, run.end_time)}`, `本次执行开始：\`${new Date(run.start_time).toISOString()}\``, '', '| 阶段 | 结果 | 模式 | 耗时 |', '|---|---|---|---|'];
  for (const [id, title] of stages) {
    const job = byId.get(id), row = id === 'build' ? report?.productionBuild : id === 'ut' ? report?.npmTest : id === 'collect' ? report : report?.scenarios?.find(c => 'case_' + c.id === id);
    let state = row?.status ? labels[row.status] || '未知' : '未取得报告';
    if (!job) state += '；平台任务缺失';
    else if (job.status !== 'COMPLETED') state += '；平台' + (labels[job.status] || '状态未知');
    lines.push(`| ${title} | ${state} | ${['mock', 'real'].includes(row?.mode) ? row.mode === 'real' ? 'Real' : 'Mock' : '—'} | ${duration(job?.start_time, job?.end_time)} |`);
  }
  const ut = report?.npmTest, counts = ut?.observedSummary;
  if (counts && ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo'].every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0) && counts.tests === counts.pass + counts.fail + counts.skipped + counts.cancelled + counts.todo) {
    lines.push('', `UT：总数 ${counts.tests}，通过 ${counts.pass}，失败 ${counts.fail}，跳过 ${counts.skipped}，取消 ${counts.cancelled}。${ut.fullSuiteComplete && !ut.interrupted ? '已完整执行。' : '执行不完整，计数仅为观测结果。'}`);
  } else lines.push('', 'UT：未取得有效完整计数，不能按通过统计。');
  const problems = [];
  if (reportProblem) problems.push(reportProblem);
  for (const row of report?.scenarios || []) if (row.status !== 'PASS') {
    const failed = row.stages?.find(s => ['FAIL', 'BLOCKED'].includes(s.status));
    problems.push(`${row.id}：${row.firstProblem || failed?.id || row.status}；${row.reason || (typeof failed?.actual === 'string' ? failed.actual : '')}`);
  }
  for (const failure of ut?.failures?.slice(0, 10) || []) problems.push(`UT ${failure.file}：${failure.title}`);
  if (report?.productionBuild?.status !== 'PASS' && report?.productionBuild?.reason) problems.push('生产编译：' + report.productionBuild.reason);
  for (const problem of report?.aggregationErrors?.slice(0, 5) || []) problems.push(problem);
  if (problems.length) lines.push('', '### 失败或阻塞原因', '', ...problems.slice(0, 20).map(p => '- ' + safe(p, secrets)));
  lines.push('', `[流水线详情与制品](https://atomgit.com/${repository}/actions/runs/${run.workflow_run_id})`, '', '制品：`pr-e2e`（`summary.md` / `report.html` / `report.json`）。跳过不等于通过；Mock 不等于真实模型验证。');
  return { body: lines.join('\n') + '\n', metadata, status };
}

function owned(comment, user) {
  return comment.user?.login === user.login && [comment.user?.id, comment.user?.object_id].some(id => id !== undefined && [user.id, user.object_id].includes(id));
}
function existingMetadata(comment) {
  const match = comment.body?.match(/^<!-- agent-insight-actions-result:v1 (\{[^\r\n]+\}) -->\n/);
  if (!match) throw Error('Invalid existing result comment metadata');
  return JSON.parse(match[1]);
}

export async function scanPrResults({ api, repository, prNumber, runId, publish = false, dryRun = false, writerIdentity, now = Date.now() }) {
  const prefix = api.repoPath(repository), repo = await api.request('GET', prefix);
  assert.equal(repo.full_name, repository);assert.equal(repo.default_branch, 'master');
  const recentRuns = prNumber ? [] : await list(api, prefix + '/actions/runs?event=MR', 'workflow_runs', 8);
  const numbers = prNumber ? [prNumber] : [...new Set(recentRuns.filter(r => r.file_path === workflowPath && (r.end_time || r.start_time) >= now - 86_400_000).map(r => Number(r.pull_request_id)).filter(n => Number.isSafeInteger(n) && n > 0))];
  const pulls = numbers.map(number => ({ number }));
  const results = [];let user = writerIdentity;
  for (const listed of pulls) {
    try {
      const pull = await api.readPull(repository, listed.number);
      if (!Number.isSafeInteger(pull.number) || !canReport(pull) || pull.base?.ref !== 'master' || !sha(pull.head?.sha)) { results.push({ pr: pull.number, status: 'SKIPPED' });continue; }
      const runs = await list(api, prefix + '/actions/runs?event=MR&pull_request_id=' + pull.number, 'workflow_runs', 8);
      const relevant = runs.filter(r => boundRun(r, pull));
      relevant.sort((a, b) => b.run_number - a.run_number || (b.attempt || 1) - (a.attempt || 1));
      const selected = relevant[0];
      if (!selected || !terminal.has(selected.status) || runId && runId !== selected.workflow_run_id) { results.push({ pr: pull.number, status: 'WAITING_OR_STALE' });continue; }
      const run = await api.request('GET', prefix + '/actions/runs/' + selected.workflow_run_id, undefined, { apiVersion: 8 });
      if (!boundRun(run, pull) || !terminal.has(run.status) || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || !Number.isSafeInteger(run.start_time) || run.start_time < 1) { results.push({ pr: pull.number, status: 'WAITING_OR_STALE' });continue; }
      const response = await api.request('GET', prefix + '/actions/runs/' + run.workflow_run_id + '/jobs', undefined, { apiVersion: 8 });
      if (!Array.isArray(response?.jobs) || new Set(response.jobs.map(j => j.identifier)).size !== response.jobs.length) throw Error('Invalid platform job list');
      const route = prefix + '/pulls/' + pull.number + '/comments';
      let existing = [];
      if (publish && !dryRun) {
        user ||= await api.request('GET', '/user');
        assert.ok(user?.login && (user.id || user.object_id), 'Authenticated writer identity is unavailable');
        existing = (await list(api, route)).filter(c => owned(c, user) && c.body?.startsWith(`<!-- ${marker} `));
        if (existing.length > 1) throw Error('Multiple owned result comments need reconciliation');
        if (existing.length) {
          const previous = existingMetadata(existing[0]);
          if (previous.repository !== repository || previous.pr !== pull.number || previous.workflowId !== run.workflow_id) throw Error('Existing result belongs to another workflow');
          if (previous.headSha === pull.head.sha && newer(previous, run)) { results.push({ pr: pull.number, status: 'STALE' });continue; }
          if (previous.headSha === run.head_sha && previous.runId === run.workflow_run_id && previous.attempt === run.attempt && previous.runStartedAt === run.start_time && previous.platformStatus === run.status && previous.reportVerified === true && previous.catalogHash === catalogHash) {
            results.push({ pr: pull.number, status: 'UNCHANGED', commentId: existing[0].id });continue;
          }
        }
      }
      let report, baseSha, testScope, reportProblem;
      try { ({ report, baseSha, testScope } = await loadReport(api, repository, run, response.jobs)); }
      catch (error) { reportProblem = error.code === 'PR_REPORT_EXECUTION' ? '最终报告或阶段结果不属于本次执行，不能复用历史制品；请检查本次制品上传步骤。' : error.code === 'PR_REPORT_ATTEMPT' ? '最终汇总报告不可验证：缺少本次重跑轮次标识，不能把旧报告视为当前重跑结果。' : `最终汇总报告缺失或不可验证（${error.reportCheckpoint || '报告验证'}），不能确认完整门禁通过。`; }
      const rendered = renderPrResult({ repository, pr: pull, run, jobs: response.jobs, report, baseSha, testScope, reportProblem, secrets: [api.token].filter(Boolean) });
      if (!publish || dryRun) { results.push({ pr: pull.number, status: 'PREVIEW', body: rendered.body });continue; }
      if (existing.length) {
        const previous = existingMetadata(existing[0]);
        if (previous.repository !== repository || previous.pr !== pull.number || previous.workflowId !== run.workflow_id) throw Error('Existing result belongs to another workflow');
        if (previous.headSha === pull.head.sha && newer(previous, rendered.metadata)) { results.push({ pr: pull.number, status: 'STALE' });continue; }
        if (existing[0].body === rendered.body) { results.push({ pr: pull.number, status: 'UNCHANGED', commentId: existing[0].id });continue; }
      }
      const current = await api.readPull(repository, pull.number);
      if (!canReport(current) || current.head?.sha !== pull.head.sha || current.base?.ref !== 'master') { results.push({ pr: pull.number, status: 'STALE' });continue; }
      // Recheck the attempt and newest run after artifact download, before mutating the PR.
      const latestRuns = await list(api, prefix + '/actions/runs?event=MR&pull_request_id=' + pull.number, 'workflow_runs', 8);
      const latest = latestRuns.filter(r => boundRun(r, current)).sort((a, b) => b.run_number - a.run_number)[0];
      const latestRun = await api.request('GET', prefix + '/actions/runs/' + run.workflow_run_id, undefined, { apiVersion: 8 });
      if (latest?.workflow_run_id !== run.workflow_run_id || latestRun.attempt !== run.attempt || latestRun.start_time !== run.start_time || latestRun.status !== run.status) { results.push({ pr: pull.number, status: 'STALE' });continue; }
      if (existing.length) await api.request('PATCH', prefix + '/pulls/comments/' + existing[0].id, { body: rendered.body });
      else await api.request('POST', route, { body: rendered.body });
      const saved = (await list(api, route)).find(c => owned(c, user) && c.body === rendered.body);
      if (!saved?.id) throw Error('Published comment read-back mismatch');
      results.push({ pr: pull.number, status: existing.length ? 'UPDATED' : 'PUBLISHED', commentId: saved.id, url: `https://atomgit.com/${repository}/merge_requests/${pull.number}` });
    } catch (error) {
      const policyDenied = error.httpStatus === 405 && /not allowed to be reviewed after being merged/.test(error.message);
      results.push({ pr: listed.number, status: policyDenied ? 'SKIPPED_MERGED_COMMENTS_DISABLED' : 'ERROR', reason: policyDenied ? '仓库未启用合并后继续做代码检视和评论，无法补发已合并 PR 的结果。' : safe(error.message, [api.token].filter(Boolean)) });
    }
  }
  return results;
}

export function readOptions(args, env = process.env) {
  const { values } = parseArgs({ args, options: { repository: { type: 'string' }, pr: { type: 'string' }, 'run-id': { type: 'string' }, publish: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  const repository = values.repository || env.ATOMGIT_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw Error('Invalid repository');
  const pr = values.pr || env.PR_COMMENT_PR_NUMBER, runId = values['run-id'] || env.PR_COMMENT_RUN_ID;
  if (pr && (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr)))) throw Error('Invalid PR number');
  if (runId && (!pr || !/^[a-f0-9]{32}$/.test(runId))) throw Error('Explicit run ID requires a valid PR number');
  if (!['', 'true', 'false'].includes(env.PR_COMMENT_DRY_RUN || '')) throw Error('Invalid dry-run flag');
  const writerId = env.PR_COMMENT_WRITER_ID, writerLogin = env.PR_COMMENT_WRITER_LOGIN;
  if ((writerId || writerLogin) && (!/^[\w-]{1,128}$/.test(writerId || '') || !/^[\w.-]{1,100}$/.test(writerLogin || ''))) throw Error('Invalid trusted writer identity');
  return { repository, prNumber: pr ? Number(pr) : undefined, runId: runId || undefined, publish: values.publish === true, dryRun: values['dry-run'] === true || env.PR_COMMENT_DRY_RUN === 'true', writerIdentity: writerId ? { id: writerId, login: writerLogin } : undefined };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = await scanPrResults({ ...readOptions(process.argv.slice(2)), api: new AtomGit() });
    console.log(JSON.stringify(results, null, 2));
    if (process.env.ATOMGIT_STEP_SUMMARY) fs.appendFileSync(process.env.ATOMGIT_STEP_SUMMARY, '## PR 结果回写\n\n' + results.map(r => `- PR !${r.pr}：${r.status}`).join('\n') + '\n');
    if (results.some(r => r.status === 'ERROR')) process.exitCode = 1;
  } catch (error) { console.error('PR result reporting failed:', redact(error.message, [process.env.ATOMGIT_TOKEN].filter(Boolean)));process.exitCode = 1; }
}
