import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { actionsConfiguration } from './actions-config.mjs';
import { configSnapshot } from '../shared/config.mjs';
import { cases } from '../shared/catalog.mjs';
import { requiredStagesFor } from '../shared/core.mjs';
import { scanPrResults, decodeReportArchive, readOptions } from './actions-pr-comment.mjs';

const repo = 'example/platform', head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40);
const runId = 'd'.repeat(32), workflow = 'e'.repeat(32), bot = { id: 'bot-id', login: 'ci-bot' };
function zip(entries) {
  const script = 'import sys,io,json,zipfile\no=io.BytesIO()\nwith zipfile.ZipFile(o,"w",zipfile.ZIP_DEFLATED) as z:\n for name,body in json.load(sys.stdin):z.writestr(name,body)\nsys.stdout.buffer.write(o.getvalue())';
  const result = spawnSync('python3', ['-c', script], { input: JSON.stringify(entries), maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0);return result.stdout;
}
function fixture() {
  const configuration = configSnapshot(actionsConfiguration({ event: 'pull_request', env: {} }));
  const report = { platformRunAttempt: 1, phase: 'collect', resultScope: 'workflow', executionOrigin: 'atomgit-job', runId: 'atomgit-' + runId, testedSha: merge, mode: 'mock', selected: cases.map(c => c.id), configuration, status: 'PASS', endedAt: '2026-11-12T02:00:00Z', productionBuild: { status: 'PASS', exitCode: 0, buildId: 'fixture' }, npmTest: { status: 'PASS', fullSuiteComplete: true, interrupted: false, observedSummary: { tests: 5, pass: 4, fail: 0, skipped: 1, cancelled: 0, todo: 0 } }, scenarios: cases.map(c => ({ id: c.id, title: c.title, status: 'PASS', mode: 'mock', stages: requiredStagesFor(c.id).map(id => ({ id, status: 'PASS' })) })) };
  const pull = { number: 7, state: 'open', head: { sha: head }, base: { ref: 'master', sha: base } };
  const run = { workflow_run_id: runId, workflow_id: workflow, file_path: '.atomgit/workflows/pr-e2e.yml', event: 'MR', pull_request_id: '7', head_sha: head, status: 'COMPLETED', run_number: 3, attempt: 1, start_time: 1000, end_time: 2000 };
  const jobs = ['build', 'ut', 'case_001', 'case_002', 'case_003', 'case_004', 'case_005', 'collect'].map(identifier => ({ identifier, status: 'COMPLETED', start_time: 1000, end_time: 2000 }));
  report.startedAt = new Date(1100).toISOString();
  for (const row of [report.productionBuild, report.npmTest, ...report.scenarios]) row.startedAt = report.startedAt;
  const comments = [], writes = [];let archive, artifactCreatedAt;
  const api = { token: 'synthetic-sensitive-token', repoPath: r => '/repos/' + r, readPull: async () => structuredClone(pull),
    downloadArtifact: async () => archive,
    request: async (method, route, body) => {
      if (method !== 'GET') { writes.push({ method, route, body });if (method === 'POST') { const c = { id: 11, body: body.body, user: bot };comments.push(c);return { id: 'discussion-key', note_id: 11, body: body.body }; }comments.find(c => String(c.id) === route.split('/').at(-1)).body = body.body;return {}; }
      if (route === '/user') return bot;
      if (route === '/repos/' + repo) return { full_name: repo, default_branch: 'master' };
      if (route.includes('/pulls?')) return [structuredClone(pull)];
      if (route.includes('/pulls/7/comments')) return structuredClone(comments);
      if (route.includes('/commits/')) return { sha: merge, parents: [{ sha: base }, { sha: head }] };
      if (route.endsWith('/jobs')) return { total_count: jobs.length, jobs: structuredClone(jobs) };
      if (route.endsWith('/artifacts')) return { artifacts: [{ id: '123', name: 'pr-e2e', created_at: artifactCreatedAt, size_bytes: archive.length, digest: 'sha256:' + createHash('sha256').update(archive).digest('hex'), workflow_id: workflow, workflow_run_id: runId }] };
      if (route.includes('/actions/runs?')) return { total_count: 1, workflow_runs: [structuredClone(run)] };
      if (route.endsWith('/actions/runs/' + runId)) return structuredClone(run);
      throw new Error('Unexpected fixture API route: ' + route);
    },
  };
  const refresh = () => { report.platformRunAttempt = run.attempt;artifactCreatedAt = new Date(run.start_time + 500).toISOString();archive = zip([['report.json', JSON.stringify(report)]]); };
  refresh();return { api, pull, run, jobs, report, comments, writes, refresh };
}
const scan = (f, overrides = {}) => scanPrResults({ api: f.api, repository: repo, publish: true, now: 2000, ...overrides });

test('a capped global scan publishes collected recent candidates and reports incomplete discovery', async () => {
  const f = fixture(), request = f.api.request;let pages = 0;
  f.api.request = (method, route, body, options) => {
    if (route.includes('/actions/runs?event=MR&per_page=')) {
      pages++;const rows = Array.from({ length: 100 }, () => ({ ...f.run, start_time: -172_800_000, end_time: -172_800_000 }));
      if (pages === 1) rows[0] = structuredClone(f.run);
      return Promise.resolve({ workflow_runs: rows });
    }
    return request(method, route, body, options);
  };
  const result = await scan(f);
  assert.equal(pages, 20);assert.ok(result.some(r => r.status === 'SCAN_INCOMPLETE' && r.scannedRuns === 2000));
  assert.ok(result.some(r => r.pr === 7 && r.status === 'PUBLISHED'));assert.equal(f.comments.length, 1);
});
test('comment discovery remains exhaustive rather than creating duplicates after a pagination cap', async () => {
  const f = fixture(), request = f.api.request;
  f.api.request = (method, route, body, options) => route.includes('/pulls/7/comments?')
    ? Promise.resolve(Array.from({ length: 100 }, (_, id) => ({ id, user: bot, body: 'unrelated comment' })))
    : request(method, route, body, options);
  assert.equal((await scan(f))[0].status, 'ERROR');assert.equal(f.writes.length, 0);
});
test('older pages can contain an earlier-started run that completed inside the scan window', async () => {
  const f = fixture(), request = f.api.request, now = Date.parse('2026-11-13T00:00:00Z');let pages = 0;
  f.run.start_time = now - 2 * 86_400_000;f.run.end_time = now - 1000;
  f.report.startedAt = new Date(f.run.start_time + 100).toISOString();
  for (const row of [f.report.productionBuild, f.report.npmTest, ...f.report.scenarios]) row.startedAt = f.report.startedAt;
  f.refresh();
  f.api.request = (method, route, body, options) => {
    if (route.includes('/actions/runs?event=MR&per_page=')) return Promise.resolve({ workflow_runs: ++pages === 1
      ? Array.from({ length: 100 }, () => ({ ...f.run, pull_request_id: '8', end_time: now - 2 * 86_400_000 }))
      : [structuredClone(f.run)] });
    return request(method, route, body, options);
  };
  assert.equal((await scan(f, { now }))[0].status, 'PUBLISHED');assert.equal(pages, 2);
});

test('publishes one verified result, reads back, deduplicates and updates a rerun in place', async () => {
  const f = fixture();await scan(f);assert.equal(f.writes.length, 1);assert.match(f.comments[0].body, /完整 UT/);assert.match(f.comments[0].body, /通过 4/);assert.match(f.comments[0].body, new RegExp(merge));
  for (const c of cases) assert.ok(f.comments[0].body.includes(c.title));
  await scan(f);assert.equal(f.writes.length, 1);
  f.run.attempt = 2;f.refresh();await scan(f);assert.equal(f.writes.length, 2);assert.equal(f.writes[1].method, 'PATCH');assert.equal(f.comments.length, 1);
});
test('a rerun with an unchanged attempt rejects the old artifact, then updates the same comment with fresh evidence', async () => {
  const f = fixture();await scan(f);f.run.start_time += 10_000;f.run.end_time += 10_000;
  assert.equal((await scan(f))[0].status, 'UPDATED');assert.match(f.comments[0].body, /不属于本次执行|不可验证/);assert.doesNotMatch(f.comments[0].body, /通过 4/);
  f.report.startedAt = new Date(f.run.start_time + 100).toISOString();
  for (const row of [f.report.productionBuild, f.report.npmTest, ...f.report.scenarios]) row.startedAt = f.report.startedAt;
  f.refresh();assert.equal((await scan(f))[0].status, 'UPDATED');assert.match(f.comments[0].body, /通过 4/);assert.equal(f.comments.length, 1);
  assert.equal((await scan(f))[0].status, 'UNCHANGED');
});
test('newly uploaded reports cannot reuse passing phases from a previous execution', async () => {
  const f = fixture();f.run.start_time += 10_000;f.run.end_time += 10_000;f.report.startedAt = new Date(f.run.start_time + 100).toISOString();f.refresh();
  await scan(f);assert.match(f.comments[0].body, /不属于本次执行|不可验证/);assert.doesNotMatch(f.comments[0].body, /通过 4/);
});
test('an execution restarting during report verification cannot receive an older comment update', async () => {
  const f = fixture(), request = f.api.request;let reads = 0;
  f.api.request = (method, route, body, options) => {
    if (route.endsWith('/actions/runs/' + runId) && ++reads === 2) f.run.start_time += 10_000;
    return request(method, route, body, options);
  };
  assert.equal((await scan(f))[0].status, 'STALE');assert.equal(f.writes.length, 0);
});
test('a failed case does not turn a passing UT into a failed UT', async () => {
  const f = fixture();f.run.status = 'FAILED';f.jobs.find(j => j.identifier === 'case_005').status = 'FAILED';f.jobs.at(-1).status = 'FAILED';f.report.status = 'BLOCKED';f.report.scenarios[4].status = 'FAIL';f.report.scenarios[4].firstProblem = 'ras-evidence';f.refresh();
  await scan(f);assert.match(f.comments[0].body, /ras-evidence/);assert.match(f.comments[0].body, /完整 UT.*通过/);
});
test('missing report and canceled execution stay incomplete rather than becoming a pass', async () => {
  const f = fixture();const request = f.api.request;f.api.request = (method, route, body, options) => route.endsWith('/artifacts') ? Promise.resolve({ artifacts: [] }) : request(method, route, body, options);
  await scan(f);assert.match(f.comments[0].body, /阻塞|不完整/);assert.doesNotMatch(f.comments[0].body, /通过 4/);
  f.run.status = 'CANCELED';f.run.attempt++;await scan(f);assert.match(f.comments[0].body, /已取消/);
});
test('dry-run cannot write even when publish was requested', async () => {
  const f = fixture();await scan(f, { dryRun: true });assert.equal(f.writes.length, 0);
});
test('closed, stale, cross-PR and active runs never publish', async () => {
  for (const mutate of [f => { f.pull.state = 'closed'; }, f => { f.pull.head.sha = 'f'.repeat(40); }, f => { f.run.pull_request_id = '8'; }, f => { f.run.status = 'RUNNING'; }]) {
    const f = fixture();mutate(f);await scan(f);assert.equal(f.writes.length, 0);
  }
});
test('latest running execution prevents an older completed run from being posted', async () => {
  const f = fixture(), request = f.api.request;f.api.request = (method, route, body, options) => route.includes('/actions/runs?') ? Promise.resolve({ total_count: 2, workflow_runs: [{ ...f.run, workflow_run_id: '1'.repeat(32), run_number: 4, start_time: 3000, status: 'RUNNING' }, f.run] }) : request(method, route, body, options);
  await scan(f);assert.equal(f.writes.length, 0);
});
test('head is checked again immediately before writing', async () => {
  const f = fixture();let reads = 0;f.api.readPull = async () => ({ ...f.pull, head: { sha: ++reads > 1 ? 'f'.repeat(40) : head } });
  await scan(f);assert.equal(f.writes.length, 0);
});
test('a report for a different source or an invalid successful suite is reported as blocked', async () => {
  for (const mutate of [f => { f.report.runId = 'another-run'; }, f => { f.report.npmTest.fullSuiteComplete = false; }, f => { f.report.scenarios.pop(); }]) {
    const f = fixture();mutate(f);f.refresh();await scan(f);assert.match(f.comments[0].body, /阻塞|不完整/);
  }
});
test('a newer bot-owned result cannot be overwritten by an older run', async () => {
  const f = fixture();f.run.attempt = 2;f.refresh();await scan(f);f.run.attempt = 1;await scan(f);assert.equal(f.writes.length, 1);
});
test('comments by other people are never edited and diagnostic text cannot mention users or expose the token', async () => {
  const f = fixture();await scan(f);f.comments[0].user = { id: 'human', login: 'someone' };
  f.report.status = 'FAIL';f.report.npmTest.status = 'FAIL';f.report.npmTest.failures = [{ file: 'test/example.test.ts', title: '@all <script> [' + f.api.token + '](https://bad.invalid)' }];f.refresh();await scan(f);
  assert.equal(f.comments.length, 2);assert.equal(f.writes[1].method, 'POST');assert.doesNotMatch(f.comments[1].body, /@all|<script>|synthetic-sensitive-token/);
});
test('ZIP parser rejects missing, repeated and oversized report members without extracting files', () => {
  assert.throws(() => decodeReportArchive(zip([['../report.json', '{}']])), /report|archive/i);
  assert.throws(() => decodeReportArchive(zip([['report.json', '{}'], ['report.json', '{}']])), /report|archive/i);
  assert.throws(() => decodeReportArchive(zip([['report.json', ' '.repeat(1_048_577)]])), /report|archive/i);
  assert.deepEqual(decodeReportArchive(zip([['report.json', '{"status":"FAIL"}']])), { status: 'FAIL' });
});
test('manual options reject bad values, require a PR for an explicit run and honor the dry-run override', () => {
  assert.equal(readOptions(['--repository', repo, '--publish'], { PR_COMMENT_DRY_RUN: 'true' }).dryRun, true);
  assert.throws(() => readOptions(['--repository', repo], { PR_COMMENT_PR_NUMBER: '7;bad' }), /PR/);
  assert.throws(() => readOptions(['--repository', repo], { PR_COMMENT_RUN_ID: runId }), /PR/);
  assert.throws(() => readOptions(['--repository', repo], { PR_COMMENT_DRY_RUN: 'yes' }), /dry/i);
  assert.deepEqual(readOptions(['--repository', repo], { PR_COMMENT_WRITER_ID: bot.id, PR_COMMENT_WRITER_LOGIN: bot.login }).writerIdentity, bot);
  assert.throws(() => readOptions(['--repository', repo], { PR_COMMENT_WRITER_ID: bot.id }), /writer/i);
});
test('trusted writer identity avoids global user access and still checks the exact comment author', async () => {
  const f = fixture(), request = f.api.request;
  f.api.request = async (method, route, body, options) => {
    assert.notEqual(route, '/user');return request(method, route, body, options);
  };
  const options = { api: f.api, repository: repo, publish: true, now: 2000, writerIdentity: bot };
  assert.equal((await scanPrResults(options))[0].status, 'PUBLISHED');
  assert.equal((await scanPrResults(options))[0].status, 'UNCHANGED');
  f.run.attempt++;f.refresh();assert.equal((await scanPrResults(options))[0].status, 'UPDATED');
  assert.equal(f.comments.length, 1);
});
test('writer workflow is scheduled and master-only, without PR code or model secrets', () => {
  const workflowText = fs.readFileSync(new URL('../../../.atomgit/workflows/pr-result-comment.yml', import.meta.url), 'utf8');
  assert.match(workflowText, /\*\/5 \* \* \* \*/);assert.match(workflowText, /refs\/heads\/master/);assert.match(workflowText, /action: read/);assert.match(workflowText, /pr: write/);assert.match(workflowText, /project: read/);assert.match(workflowText, /note: write/);
  assert.doesNotMatch(workflowText, /pull_request:|pull_request_target:|secrets\.|allow-unsafe-pr-checkout|npm (?:ci|install)/);
});

test('API permission failures identify the path without exposing query credentials or response data', async t => {
  const { default: http } = await import('node:http');
  const { AtomGit } = await import('./atomgit.mjs');
  const server = http.createServer((_req, res) => { res.writeHead(403);res.end('synthetic-sensitive-response'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = new AtomGit({ token: 'synthetic-token', baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v5', localTest: true });
  await assert.rejects(api.request('GET', '/repos/example/platform?access_token=synthetic-query'), error => {
    assert.match(error.message, /GET \/api\/v5\/repos\/example\/platform failed \(HTTP 403\)/);
    assert.doesNotMatch(error.message, /synthetic|access_token/);return true;
  });
});

test('API errors retain bounded server diagnostics and redact the active token', async t => {
  const { default: http } = await import('node:http');
  const { AtomGit } = await import('./atomgit.mjs');
  const server = http.createServer((_req, res) => { res.writeHead(405);res.end(JSON.stringify({ error_code: 405, error_code_name: 'METHOD_DENIED', error_message: 'method rejected synthetic-token' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = new AtomGit({ token: 'synthetic-token', baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v5', localTest: true });
  await assert.rejects(api.request('POST', '/repos/example/platform/pulls/7/comments', { body: 'test' }), error => {
    assert.equal(error.httpStatus, 405);assert.match(error.message, /METHOD_DENIED.*method rejected \[REDACTED\]/);assert.doesNotMatch(error.message, /synthetic-token/);return true;
  });
});

test('merged PR policy rejection is reported and a stale policy snapshot cannot block a permitted write', async () => {
  const f = fixture();f.pull.state = 'merged';f.pull.mergeable_state = { merge_request_switch: { add_notes_after_merged: false } };
  let serverAllowsComments = false;const request = f.api.request;
  f.api.request = async (method, route, body, options) => {
    if (method !== 'GET' && !serverAllowsComments) throw Object.assign(Error('The current merge request is not allowed to be reviewed after being merged, change the settings to enable this operation'), { httpStatus: 405 });
    return request(method, route, body, options);
  };
  const blocked = await scan(f);assert.equal(blocked[0].status, 'SKIPPED_MERGED_COMMENTS_DISABLED');assert.equal(f.writes.length, 0);
  const preview = await scanPrResults({ api: f.api, repository: repo, prNumber: 7, publish: true, dryRun: true });
  assert.equal(preview[0].status, 'PREVIEW');assert.equal(f.writes.length, 0);
  serverAllowsComments = true;
  assert.equal((await scan(f))[0].status, 'PUBLISHED');
});

test('real HTTP scanner uses v8 metadata, strips credentials at the artifact redirect and updates one comment', async t => {
  const { default: http } = await import('node:http');
  const { AtomGit } = await import('./atomgit.mjs');
  const f = fixture();let downloads = 0;
  let archive = zip([['report.json', JSON.stringify(f.report)]]);
  const cdn = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);assert.equal(req.headers.cookie, undefined);downloads++;
    res.setHeader('content-length', archive.length);res.end(archive);
  });
  await new Promise(resolve => cdn.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => cdn.close(resolve)));
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + f.api.token);
    const route = req.url.replace(/^\/api\/v[58]/, '');let text = '';for await (const chunk of req) text += chunk;
    if (route.endsWith('/actions/artifacts/123/zip')) { res.writeHead(302, { location: 'http://127.0.0.1:' + cdn.address().port + '/report.zip' });res.end();return; }
    if (route.includes('/actions/')) assert.ok(req.url.startsWith('/api/v8/'));
    try {
      const value = route.endsWith('/pulls/7') ? f.pull : await f.api.request(req.method, route, text ? JSON.parse(text) : undefined);
      res.setHeader('content-type', 'application/json');res.end(JSON.stringify(value));
    } catch { res.writeHead(404);res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = new AtomGit({ token: f.api.token, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v5', localTest: true });
  const first = await scanPrResults({ api, repository: repo, publish: true, now: 2000 });
  assert.equal(first[0].status, 'PUBLISHED', JSON.stringify(first));assert.equal(downloads, 1, f.comments[0]?.body);assert.equal(f.comments.length, 1);
  const second = await scanPrResults({ api, repository: repo, publish: true, now: 2000 });assert.equal(second[0].status, 'UNCHANGED');assert.equal(f.writes.length, 1);
  f.run.attempt = 2;f.refresh();archive = zip([['report.json', JSON.stringify(f.report)]]);const third = await scanPrResults({ api, repository: repo, publish: true, now: 2000 });assert.equal(third[0].status, 'UPDATED');assert.equal(f.comments.length, 1);
});

test('a verified unchanged result survives artifact retention expiry without being downgraded', async () => {
  const f = fixture();await scan(f);f.api.downloadArtifact = async () => { throw Error('artifact expired'); };
  const result = await scan(f);assert.equal(result[0].status, 'UNCHANGED');assert.equal(f.writes.length, 1);
});
test('an artifact checksum mismatch cannot produce a successful comment', async () => {
  const f = fixture();f.api.downloadArtifact = async () => Buffer.from('tampered');await scan(f);
  assert.match(f.comments[0].body, /阻塞/);assert.doesNotMatch(f.comments[0].body, /通过 4/);
});

test('malformed blocked reports and invalid passing subitems produce a blocked comment', async () => {
  for (const mutate of [f => { f.report.scenarios[0].stages = {}; }, f => { f.report.npmTest.failures = {}; }, f => { f.report.npmTest.fullSuiteComplete = false; }]) {
    const f = fixture();f.report.status = 'BLOCKED';mutate(f);f.refresh();const result = await scan(f);
    assert.notEqual(result[0].status, 'ERROR');assert.match(f.comments[0].body, /不可验证/);assert.doesNotMatch(f.comments[0].body, /完整 UT \| 通过/);
  }
});
test('merged PRs can receive results but closed unmerged PRs cannot', async () => {
  const f = fixture();f.pull.state = 'merged';const result = await scan(f);assert.equal(result[0].status, 'PUBLISHED');
  f.pull.state = 'closed';const closed = await scan(f);assert.equal(closed[0].status, 'SKIPPED');assert.equal(f.writes.length, 1);
});

test('source-head fallback reports are bound exactly and labeled without claiming merged-master coverage', async () => {
  const f = fixture(), request = f.api.request;f.report.testedSha = head;f.refresh();
  f.api.request = (method, route, body, options) => route.includes('/commits/') ? Promise.resolve({ sha: head, parents: [{ sha: base }] }) : request(method, route, body, options);
  await scan(f);assert.match(f.comments[0].body, /源提交（非预合并）/);assert.match(f.comments[0].body, /通过 4/);
});
test('a rerun without explicit matching attempt provenance does not reuse the old report', async () => {
  const f = fixture();f.run.attempt = 2;await scan(f);assert.match(f.comments[0].body, /缺少本次重跑轮次标识/);assert.doesNotMatch(f.comments[0].body, /通过 4/);
});
