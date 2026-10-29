'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const C = require('../scripts/common.cjs')
const { main, ensurePlan } = require('../scripts/onboard.cjs')
const { compareScores, runCommand } = require('../scripts/checks.cjs')
const { record } = require('../scripts/record-job.cjs')
const { compareProtocol } = require('../scripts/protocol-check.cjs')

const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2)) }
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-test-'))
  const repo = path.join(root, 'project with spaces')
  fs.mkdirSync(repo)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(repo, 'protocol.md'), 'Fixture protocol, not a real Benchmark.\n')
  write(path.join(repo, 'benchmarks/fixture/benchmark.yaml'), 'key: fixture\n')
  write(path.join(repo, 'scripts/benchmark/generate-catalog.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
module.exports.loadPackage = directory => {
  if (fs.readFileSync(path.join(directory, 'benchmark.yaml'), 'utf8') !== 'key: fixture\\n') throw new Error('fixture catalog rejected manifest');
  return { key: path.basename(directory), packageDigest: 'fixture-digest' };
};
`)
  const submissions = ['correct', 'incorrect', 'invalid', 'boundary'].map((kind, i) => ({ id: `sample-${i}`, kind, answer: i, digest: C.hash(`submission-${i}`) }))
  write(path.join(repo, 'submissions.json'), submissions)
  write(path.join(repo, 'official.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'submissions.json')));
const cases = rows.map(r => ({id:r.id, caseId:'case-1', kind:r.kind, submissionDigest:r.digest, status:r.kind === 'invalid' ? 'invalid' : 'completed', metrics:r.kind === 'invalid' ? {} : {score:r.kind === 'correct' ? 1 : r.kind === 'boundary' ? 0.5 : 0, passed:r.kind === 'correct'}}));
fs.writeFileSync(process.argv[2], JSON.stringify({schemaVersion:'benchmark-onboarding-scores/v1', benchmarkKey:'fixture', cases, aggregate:{mean:0.5}}));
fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'native-official.json'), JSON.stringify(cases));
`)
  write(path.join(repo, 'candidate.cjs'), `
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const kinds = ['correct','incorrect','invalid','boundary'];
const cases = kinds.map((kind,i) => ({id:'sample-'+i,caseId:'case-1',kind,submissionDigest:'sha256:'+crypto.createHash('sha256').update('submission-'+i).digest('hex'),status:i===2?'invalid':'completed',metrics:i===2?{}:{score:[1,0,0,0.5][i],passed:i===0}}));
fs.writeFileSync(process.argv[2], JSON.stringify({schemaVersion:'benchmark-onboarding-scores/v1',benchmarkKey:'fixture',cases,aggregate:{mean:0.5}}));
`)
  write(path.join(repo, 'check.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
const output=process.argv[2], category=process.argv[3];
const facts=category==='runtime'?{mode:'live',caseIds:['case-1'],steps:Object.fromEntries(['dataset','execution','submission','evaluation','evidence','cleanup'].map(step=>[step,{status:'pass',reference:'synthetic-'+step}]))}:{};
fs.writeFileSync(path.join(path.dirname(output),'raw-query.json'),JSON.stringify({synthetic:true,category}));
fs.writeFileSync(output,JSON.stringify({schemaVersion:'benchmark-onboarding-check/v1',status:'pass',evidence:['raw-query.json'],facts}));
`)
  git(repo, ['init', '-q'])
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  const runRoot = path.join(root, 'runs')
  const initial = await main(['init', '--repo', repo, '--project', repo, '--source', 'https://example.org/fixture', '--run-root', runRoot, '--id', 'test-run', '--max-attempts', String(options.maxAttempts || 8), '--max-seconds', '600'])
  const directory = initial.directory
  const cmd = file => ({ argv: [process.execPath, `{repo}/${file}`, '{output}'], cwd: '{repo}', timeoutSeconds: 10 })
  const plan = {
    schemaVersion: 'benchmark-onboarding-plan/v1', benchmarkKey: 'fixture',
    scope: { label: 'Synthetic unit test only', mode: options.mode || 'live', caseIds: ['case-1'] },
    source: { url: 'https://example.org/fixture', codeRevision: 'fixture-v1', dataRevision: 'fixture-v1', split: 'test', license: 'synthetic', caseCount: 1 },
    baselineInputs: ['{repo}/official.cjs', '{repo}/submissions.json', '{repo}/protocol.md'],
    implementationInputs: ['{repo}/candidate.cjs', '{repo}/check.cjs'],
    baseline: cmd('official.cjs'), candidate: cmd('candidate.cjs'), tolerances: {},
    checks: ['source', 'visibility', 'runtime', 'regression'].map(category => ({ id: category, category, required: true, ...cmd('check.cjs'), argv: [...cmd('check.cjs').argv, category], resultMode: 'check' })),
  }
  const planPath = path.join(root, 'plan.json')
  write(planPath, plan)
  for (const stage of ['analysis', 'capabilities', 'design']) await main(['checkpoint', '--run', directory, '--stage', stage, '--evidence', path.join(repo, 'protocol.md')])
  return { root, repo, directory, plan, planPath, freeze: () => main(['freeze', '--run', directory, '--plan', planPath]), verify: () => main(['verify', '--run', directory]), report: () => main(['report', '--run', directory]), state: () => C.readJson(path.join(directory, 'run.json')) }
}

test('independent score commands, target catalog, evidence and all required checks produce a structurally accepted unit fixture', async t => {
  const f = await fixture(t)
  assert.equal((await f.freeze()).status, 'pass')
  const report = await f.verify()
  assert.equal(report.status, 'accepted')
  const body = C.readJson(report.report)
  assert.equal(body.checks.find(c => c.id === 'scoring').comparedSamples, 4)
  assert.equal(body.budget.usedAttempts, 2)
  assert.match(fs.readFileSync(report.markdown, 'utf8'), /accepted/)
  assert.ok(body.checks.every(check => check.status === 'pass'))
})

test('fixture mode never claims real integration acceptance', async t => {
  const f = await fixture(t, { mode: 'fixture' })
  await f.freeze()
  const result = await f.verify()
  assert.equal(result.status, 'needs_action')
  assert.match(result.limitations.join(' '), /Fixture/)
})

test('init is idempotent and rejects a run ID for a different source without resetting attempts', async t => {
  const f = await fixture(t)
  await f.freeze()
  const args = ['init', '--repo', f.repo, '--project', f.repo, '--source', 'https://example.org/fixture', '--run-root', path.dirname(f.directory), '--id', 'test-run']
  assert.equal((await main(args)).reused, true)
  assert.equal(f.state().baselines.length, 1)
  args[args.indexOf('--source') + 1] = 'https://example.org/other'
  await assert.rejects(main(args), /其他任务/)
})

test('wrong project URL, credential-bearing addresses and wrong local roots are refused', async t => {
  const f = await fixture(t)
  assert.throws(() => C.project(f.repo, 'https://example.org/wrong.git'), /不匹配/)
  assert.throws(() => C.repositoryAddress('https://token@example.org/repo.git'), /凭据/)
  assert.equal(C.repositoryAddress('git@example.org:team/project.git'), C.repositoryAddress('https://example.org/team/project'))
  assert.throws(() => C.project(path.join(f.repo, 'benchmarks'), f.repo), /根目录/)
})

test('a second active run on the same working copy is blocked', async t => {
  const f = await fixture(t)
  await assert.rejects(main(['init', '--repo', f.repo, '--project', f.repo, '--source', 'https://example.org/second', '--run-root', path.join(f.root, 'other-runs')]), /未结束运行/)
  await main(['stop', '--run', f.directory, '--status', 'cancelled', '--reason', 'test finished'])
  assert.equal((await main(['init', '--repo', f.repo, '--project', f.repo, '--source', 'https://example.org/second', '--run-root', path.join(f.root, 'other-runs')])).status, 'running')
})

test('an incorrect candidate score fails while retaining official baseline and both attempts', async t => {
  const f = await fixture(t)
  await f.freeze()
  const file = path.join(f.repo, 'candidate.cjs'), original = fs.readFileSync(file, 'utf8')
  write(file, original.replace('aggregate:{mean:0.5}', 'aggregate:{mean:0.75}'))
  assert.equal((await f.verify()).status, 'failed')
  write(file, original)
  assert.equal((await f.verify()).status, 'accepted')
  assert.equal(f.state().attempts.length, 2)
  assert.equal(f.state().baselines.length, 1)
})

test('missing required checks and optional substitutes cannot pass', async t => {
  const f = await fixture(t)
  f.plan.checks = f.plan.checks.filter(c => c.category !== 'runtime')
  f.plan.checks.find(c => c.category === 'visibility').required = false
  write(f.planPath, f.plan)
  await f.freeze()
  const result = await f.verify()
  assert.equal(result.status, 'needs_action')
  const checks = C.readJson(result.report).checks
  assert.ok(checks.some(c => c.id === 'missing-runtime'))
  assert.ok(checks.some(c => c.id === 'missing-visibility'))
})

test('exit zero without structured evidence fails runtime verification', async t => {
  const f = await fixture(t)
  f.plan.checks.find(c => c.category === 'runtime').argv = [process.execPath, '-e', 'process.exit(0)']
  write(f.planPath, f.plan)
  await f.freeze()
  assert.equal((await f.verify()).status, 'failed')
})

test('mock runtime facts and incomplete cleanup cannot satisfy live validation', async t => {
  const f = await fixture(t)
  await f.freeze()
  const file = path.join(f.repo, 'check.cjs')
  const original = fs.readFileSync(file, 'utf8')
  write(file, original.replace("mode:'live'", "mode:'mock'"))
  const result = await f.verify()
  assert.equal(result.status, 'failed')
  assert.match(C.readJson(result.report).checks.find(c => c.category === 'runtime').reason, /真实链路/)
  write(file, original.replace(",'cleanup'", ''))
  const missingCleanup = await f.verify()
  assert.equal(missingCleanup.status, 'failed')
  assert.match(C.readJson(missingCleanup.report).checks.find(c => c.category === 'runtime').reason, /cleanup/)
})

test('source and official scorer changes invalidate a frozen baseline', async t => {
  const f = await fixture(t)
  await f.freeze()
  fs.appendFileSync(path.join(f.repo, 'official.cjs'), '\n')
  await assert.rejects(f.verify(), /基线失效/)
  await assert.rejects(f.freeze(), /--reason/)
  await main(['freeze', '--run', f.directory, '--plan', f.planPath, '--reason', 'official source updated'])
  assert.equal(f.state().baselines.length, 2)
})

test('fresh reports reject changed implementation and tampered evidence, ignoring a manually edited cached report', async t => {
  const f = await fixture(t)
  await f.freeze()
  const accepted = await f.verify()
  const body = C.readJson(accepted.report)
  const evidence = body.checks.find(c => c.category === 'runtime').evidence.find(e => e.path.endsWith('raw-query.json'))
  write(evidence.path, { forged: true })
  write(accepted.report, { status: 'accepted' })
  assert.equal((await f.report()).status, 'needs_action')
  fs.appendFileSync(path.join(f.repo, 'candidate.cjs'), '\n')
  assert.match((await f.report()).limitations.join(' '), /已变化/)
})

test('unknown jobs block duplicate verification and require a platform reference and evidence at completion', async t => {
  const f = await fixture(t)
  await f.freeze()
  await main(['job', '--run', f.directory, '--request-id', 'req-1', '--state', 'unknown'])
  await assert.rejects(f.verify(), /在途/)
  assert.equal(f.state().attempts.length, 0)
  await assert.rejects(main(['job', '--run', f.directory, '--request-id', 'req-1', '--platform-id', 'job-1', '--state', 'completed']), /证据/)
  const evidence = path.join(f.root, 'job.json'); write(evidence, { id: 'job-1', status: 'completed', fixture: true })
  await main(['job', '--run', f.directory, '--request-id', 'req-1', '--platform-id', 'job-1', '--state', 'completed', '--evidence', evidence])
  assert.equal((await f.verify()).status, 'accepted')
  assert.equal(f.state().jobs[0].history.length, 2)
})

test('an interrupted child task journal is read on resume and blocks duplicate submission', async t => {
  const f = await fixture(t)
  await f.freeze()
  const file = path.join(f.repo, 'check.cjs')
  fs.appendFileSync(file, `\nif (category === 'runtime') require(${JSON.stringify(path.join(C.skillRoot, 'scripts/record-job.cjs'))}).record(['--request-id','child-1','--state','unknown']);\n`)
  const result = await f.verify()
  assert.equal(result.status, 'needs_action')
  assert.equal(f.state().jobs[0].state, 'unknown')
  await assert.rejects(f.verify(), /在途/)
  const evidence = path.join(f.root, 'job-query.json')
  write(evidence, { id: 'platform-1', status: 'completed', synthetic: true })
  await main(['job', '--run', f.directory, '--request-id', 'child-1', '--platform-id', 'platform-1', '--state', 'completed', '--evidence', evidence])
  assert.equal((await main(['resume', '--run', f.directory])).resume.pendingJobs.length, 0)
  assert.equal((await main(['resume', '--run', f.directory])).jobs[0].history.length, 2)
  const journal = path.join(f.directory, 'attempts', '0001', 'runtime', 'platform-jobs')
  record(['--request-id', 'child-2', '--state', 'unknown'], journal)
  assert.equal(f.state().jobs.length, 1)
  const resumed = await main(['resume', '--run', f.directory])
  assert.equal(resumed.resume.pendingJobs[0].requestId, 'child-2')
  assert.equal(f.state().jobs.length, 1)
  await assert.rejects(f.verify(), /在途/)
})

test('child journals retain terminal query evidence and reject tampering', async t => {
  const f = await fixture(t)
  await f.freeze()
  const journal = path.join(f.directory, 'baselines', '0001', 'official', 'platform-jobs')
  record(['--request-id', 'child-1', '--state', 'unknown'], journal)
  const evidence = path.join(f.root, 'job-query.json')
  write(evidence, { id: 'platform-1', status: 'completed', synthetic: true })
  record(['--request-id', 'child-1', '--platform-id', 'platform-1', '--state', 'completed', '--evidence', evidence], journal)
  const result = await main(['resume', '--run', f.directory])
  assert.equal(result.resume.pendingJobs.length, 0)
  assert.equal(result.jobs[0].history.length, 2)
  await main(['checkpoint', '--run', f.directory, '--stage', 'analysis', '--evidence', path.join(f.repo, 'protocol.md')])
  write(path.join(journal, '000001.event.json'), { corrupt: true })
  await assert.rejects(main(['resume', '--run', f.directory]), /事件记录缺失或摘要不匹配/)
  assert.throws(() => record(['--request-id', 'child-3', '--state', 'completed'], journal), /平台任务 ID/)
})

test('an explicit deployment blocker remains visible in reports until a new verification resolves it', async t => {
  const f = await fixture(t)
  await f.freeze()
  assert.equal((await f.verify()).status, 'accepted')
  await main(['stop', '--run', f.directory, '--status', 'needs_action', '--reason', 'selected backend does not enforce the required network policy'])
  const stopped = await f.report()
  assert.equal(stopped.status, 'needs_action')
  assert.match(stopped.limitations.join(' '), /network policy/)
  assert.equal((await main(['resume', '--run', f.directory])).status, 'needs_action')
  assert.equal((await f.verify()).status, 'accepted')
  assert.equal(f.state().stopReason, undefined)
})

test('attempt budget is enforced and an explicit adjustment retains consumption and start time', async t => {
  const f = await fixture(t, { maxAttempts: 1 })
  await f.freeze()
  assert.equal((await f.freeze()).reused, true)
  const before = f.state()
  await assert.rejects(f.verify(), /预算/)
  await main(['budget', '--run', f.directory, '--max-attempts', '2', '--reason', 'authorized unit-test extension'])
  assert.equal(f.state().createdAt, before.createdAt)
  assert.equal(f.state().baselines.length, 1)
  assert.equal(f.state().budgetHistory.length, 1)
  assert.equal((await f.verify()).status, 'accepted')
})

test('unconfigured official command is blocked and cannot create an accepted baseline', async t => {
  const f = await fixture(t)
  f.plan.baseline.argv = []
  write(f.planPath, f.plan)
  assert.equal((await f.freeze()).status, 'blocked')
  assert.equal(f.state().activeBaseline, undefined)
  assert.equal((await f.report()).status, 'needs_action')
})

test('schema rejects weak modes, duplicated checks, identical scorer commands and invalid timeouts', async t => {
  const f = await fixture(t)
  const clone = () => structuredClone(f.plan)
  let plan = clone(); plan.checks[0].resultMode = 'exit-code'; assert.throws(() => ensurePlan(plan), /仅回归/)
  plan = clone(); plan.checks.push(plan.checks[0]); assert.throws(() => ensurePlan(plan), /重复/)
  plan = clone(); plan.candidate = plan.baseline; assert.throws(() => ensurePlan(plan), /相同/)
  plan = clone(); plan.baseline.timeoutSeconds = -1; assert.throws(() => ensurePlan(plan), /数字/)
  plan = clone(); plan.scope.mode = 'fake-live'; assert.throws(() => ensurePlan(plan), /允许范围/)
})

test('score comparison checks IDs, coverage, submission digests, aggregate and declared tolerances', async t => {
  const f = await fixture(t)
  await f.freeze()
  const official = C.readJson(f.state().baselines[0].scoresFile)
  const clone = () => structuredClone(official)
  let other = clone(); other.cases[0].submissionDigest = C.hash('wrong'); assert.equal(compareScores(official, other, f.plan).status, 'fail')
  other = clone(); other.cases.pop(); assert.throws(() => compareScores(official, other, f.plan), /覆盖类型/)
  other = clone(); other.cases[0].status = 'infrastructure_error'; assert.throws(() => compareScores(official, other, f.plan), /基础设施/)
  other = clone(); other.aggregate.mean += 0.01; assert.equal(compareScores(official, other, f.plan).status, 'fail')
  assert.equal(compareScores(official, other, { ...f.plan, tolerances: { mean: 0.02 } }).status, 'pass')
  assert.throws(() => compareScores(official, official, { ...f.plan, tolerances: { typo: 1 } }), /容差/)
  other = clone(); other.cases[0].metrics.score = true; assert.equal(compareScores(official, other, f.plan).status, 'fail')
})

test('command runner enforces timeout and preserves nonzero and missing executable failures', async t => {
  const f = await fixture(t)
  const context = name => ({ repo: f.repo, run: f.directory, skill: C.skillRoot, attempt: path.join(f.root, name) })
  let result = await runCommand({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: '{repo}', timeoutSeconds: 1 }, context('timeout'), Date.now() + 5000)
  assert.equal(result.status, 'fail'); assert.match(result.reason, /超时/)
  result = await runCommand({ argv: [process.execPath, '-e', 'process.exit(7)'], cwd: '{repo}', timeoutSeconds: 1 }, context('nonzero'), Date.now() + 5000)
  assert.equal(result.exitCode, 7); assert.equal(result.status, 'fail')
  result = await runCommand({ argv: [path.join(f.root, 'does-not-exist')], cwd: '{repo}', timeoutSeconds: 1 }, context('missing'), Date.now() + 5000)
  assert.match(result.reason, /ENOENT/)
})

test('timeout kills a POSIX descendant even if its parent exits and closes its pipes first', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const childFile = path.join(f.repo, 'descendant.cjs')
  write(childFile, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)")
  const parentFile = path.join(f.repo, 'parent.cjs')
  write(parentFile, `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[process.argv[2]],{stdio:'ignore'}); fs.writeFileSync(process.argv[3],String(child.pid)); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`)
  const pidFile = path.join(f.root, 'descendant.pid')
  t.after(() => { if (fs.existsSync(pidFile)) try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch {} })
  const result = await runCommand({ argv: [process.execPath, parentFile, childFile, pidFile], cwd: '{repo}', timeoutSeconds: 1 }, { repo: f.repo, run: f.directory, skill: C.skillRoot, attempt: path.join(f.root, 'descendant-timeout') }, Date.now() + 5000)
  assert.match(result.reason, /超时/)
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  let alive = true
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
    if (alive) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(alive, false)
})

test('command process lock prevents concurrent mutation of the same repository', async t => {
  const f = await fixture(t)
  await C.withLock(f.repo, async () => {
    await assert.rejects(main(['checkpoint', '--run', f.directory, '--stage', 'analysis', '--evidence', path.join(f.repo, 'protocol.md')]), /锁/)
  })
})

test('copied read-only Skill runs from another cwd with no installation writes and refuses in-package run output', async t => {
  const f = await fixture(t)
  await main(['stop', '--run', f.directory, '--status', 'cancelled', '--reason', 'switch unit-test package'])
  const copied = path.join(f.root, 'copied skill')
  fs.cpSync(C.skillRoot, copied, { recursive: true })
  const before = C.treeHash(copied)
  for (const file of C.treeFiles(copied)) fs.chmodSync(file, 0o444)
  function directories(root) { return [root, ...fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => directories(path.join(root, e.name)))] }
  const dirs = directories(copied)
  for (const dir of dirs) fs.chmodSync(dir, 0o555)
  try {
  const args = [path.join(copied, 'scripts/onboard.cjs'), 'init', '--project', f.repo, '--repo', f.repo, '--source', 'https://example.org/fixture', '--run-root', path.join(f.root, 'portable-runs'), '--id', 'portable']
  const result = spawnSync(process.execPath, args, { cwd: os.tmpdir(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).runId, 'portable')
  const run = JSON.parse(result.stdout).directory
  const invoke = arguments_ => {
    const response = spawnSync(process.execPath, [path.join(copied, 'scripts/onboard.cjs'), ...arguments_], { cwd: os.tmpdir(), encoding: 'utf8' })
    assert.equal(response.status, 0, response.stderr || response.stdout)
    return JSON.parse(response.stdout)
  }
  for (const stage of ['analysis', 'capabilities', 'design']) invoke(['checkpoint', '--run', run, '--stage', stage, '--evidence', path.join(f.repo, 'protocol.md')])
  assert.equal(invoke(['freeze', '--run', run, '--plan', f.planPath]).status, 'pass')
  assert.equal(invoke(['verify', '--run', run]).status, 'accepted')
  args[args.indexOf('--run-root') + 1] = path.join(copied, 'outputs')
  const refused = spawnSync(process.execPath, args, { cwd: os.tmpdir(), encoding: 'utf8' })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /Skill 包外/)
  assert.equal(C.treeHash(copied), before)
  } finally { for (const dir of dirs) fs.chmodSync(dir, 0o755) }
})

test('protocol comparison detects working-copy drift even at the same HEAD and does not claim capabilities', async t => {
  const f = await fixture(t)
  const packageRoot = path.join(f.root, 'snapshot package')
  write(path.join(packageRoot, 'protocol.md'), 'Stable contract snapshot')
  const snapshot = {
    schemaVersion: 'benchmark-protocol-snapshot/v1', snapshotVersion: 'fixture-1',
    source: { repository: 'https://example.org/fixture', revision: C.git(f.repo, ['rev-parse', 'HEAD']) },
    bundledFiles: [{ path: 'protocol.md', sha256: C.fileHash(path.join(packageRoot, 'protocol.md')) }],
    files: [{ path: 'protocol.md', role: 'contract', sha256: C.fileHash(path.join(f.repo, 'protocol.md')) }],
  }
  const before = C.treeHash(packageRoot)
  assert.equal(compareProtocol(f.repo, snapshot, packageRoot).status, 'match')
  write(path.join(f.repo, 'unrelated.txt'), 'Unrelated commit')
  git(f.repo, ['add', 'unrelated.txt'])
  git(f.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unrelated'])
  const unchanged = compareProtocol(f.repo, snapshot, packageRoot)
  assert.equal(unchanged.status, 'match')
  assert.notEqual(unchanged.target.head, snapshot.source.revision)
  assert.equal(unchanged.capabilities, 'not_checked')
  write(path.join(f.repo, 'protocol.md'), 'Same version identifier, changed fields')
  const changed = compareProtocol(f.repo, snapshot, packageRoot)
  assert.equal(changed.target.head, unchanged.target.head)
  assert.equal(changed.status, 'review_required')
  assert.equal(changed.files[0].status, 'changed')
  fs.renameSync(path.join(f.repo, 'protocol.md'), path.join(f.repo, 'moved.md'))
  assert.equal(compareProtocol(f.repo, snapshot, packageRoot).files[0].status, 'missing')
  assert.equal(C.treeHash(packageRoot), before)
})

test('protocol comparison rejects damaged package material and unsafe source paths', async t => {
  const f = await fixture(t)
  const packageRoot = path.join(f.root, 'snapshot package')
  write(path.join(packageRoot, 'protocol.md'), 'Snapshot')
  const snapshot = {
    schemaVersion: 'benchmark-protocol-snapshot/v1', snapshotVersion: 'fixture-1',
    source: { repository: 'https://example.org/fixture', revision: C.git(f.repo, ['rev-parse', 'HEAD']) },
    bundledFiles: [{ path: 'protocol.md', sha256: C.fileHash(path.join(packageRoot, 'protocol.md')) }],
    files: [{ path: 'protocol.md', sha256: C.fileHash(path.join(f.repo, 'protocol.md')) }],
  }
  write(path.join(packageRoot, 'protocol.md'), 'Changed without version review')
  assert.throws(() => compareProtocol(f.repo, snapshot, packageRoot), /摘要不匹配/)
  write(path.join(packageRoot, 'protocol.md'), 'Snapshot')
  snapshot.files[0].path = '../outside.md'
  assert.throws(() => compareProtocol(f.repo, snapshot, packageRoot), /相对路径/)
  snapshot.files[0].path = 'escaped.md'
  fs.symlinkSync(path.join(packageRoot, 'protocol.md'), path.join(f.repo, 'escaped.md'))
  assert.throws(() => compareProtocol(f.repo, snapshot, packageRoot), /越出根目录/)
})

test('protocol CLI remains usable from a copied Skill and returns review-required for missing target paths', async t => {
  const f = await fixture(t)
  const copied = path.join(f.root, 'portable protocol skill')
  fs.cpSync(C.skillRoot, copied, { recursive: true })
  const before = C.treeHash(copied)
  const result = spawnSync(process.execPath, [path.join(copied, 'scripts/protocol-check.cjs'), f.repo], { cwd: os.tmpdir(), encoding: 'utf8' })
  assert.equal(result.status, 2, result.stdout || result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.status, 'review_required')
  assert.ok(output.files.some(file => file.status === 'missing'))
  assert.equal(output.capabilities, 'not_checked')
  assert.equal(C.treeHash(copied), before)
})

test('packaged files and templates are complete without unfinished executable success stubs', () => {
  const root = C.skillRoot
  const text = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')
  for (const [, relative] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(root, relative)), relative)
  const plan = C.readJson(path.join(root, 'assets/templates/acceptance-plan.json'))
  assert.doesNotThrow(() => ensurePlan(plan))
  assert.ok(plan.baseline.argv.length === 0 && plan.candidate.argv.length === 0)
  assert.match(fs.readFileSync(path.join(root, 'assets/templates/adapter.ts.tmpl'), 'utf8'), /ONBOARDING_IMPLEMENTATION_REQUIRED/)
  const snapshot = C.readJson(path.join(root, 'references/benchmark-protocol.sources.json'))
  for (const file of snapshot.bundledFiles) assert.equal(C.fileHash(path.join(root, file.path)), file.sha256, file.path)
})
