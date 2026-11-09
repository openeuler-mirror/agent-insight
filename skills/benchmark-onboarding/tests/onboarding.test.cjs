'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const C = require('../scripts/common.cjs')
const { main, ensurePlan } = require('../scripts/onboard.cjs')
const { compareScores, runCommand, inspectCheck } = require('../scripts/checks.cjs')
const { record, reconcile } = require('../scripts/record-job.cjs')
const { trackedJob, normalizeState, waitForJob } = require('../scripts/tracked-job.cjs')
const { recordedOperation, copyRecordedEvidence } = require('../scripts/recorded-operation.cjs')

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
module.exports.loadPackageForOnboarding = directory => {
  if (fs.readFileSync(path.join(directory, 'benchmark.yaml'), 'utf8') !== 'key: fixture\\n') throw new Error('fixture catalog rejected manifest');
  return { key: path.basename(directory), packageDigest: 'fixture-digest' };
};
`)
  const submissions = ['correct', 'incorrect', 'invalid', 'boundary'].map((kind, i) => ({ id: `sample-${i}`, kind, answer: i, digest: C.hash(`submission-${i}`) }))
  write(path.join(repo, 'submissions.json'), submissions)
  write(path.join(repo, 'official.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'submissions.json')));
fs.appendFileSync(path.join(__dirname,'../official-calls'),'official\\n');
const cases = rows.map(r => ({id:r.id, caseId:'case-1', kind:r.kind, submissionDigest:r.digest, status:r.kind === 'invalid' ? 'invalid' : 'completed', metrics:r.kind === 'invalid' ? {} : {score:r.kind === 'correct' ? 1 : r.kind === 'boundary' ? 0.5 : 0, passed:r.kind === 'correct'}}));
fs.writeFileSync(process.argv[2], JSON.stringify({schemaVersion:'benchmark-onboarding-scores/v1', benchmarkKey:'fixture', cases, aggregate:{mean:0.5}}));
fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'native-official.json'), JSON.stringify(cases));
`)
  write(path.join(repo, 'check.cjs'), `
const fs = require('node:fs'); const path = require('node:path');
const output=process.argv[2], category=process.argv[3];
fs.writeFileSync(path.join(path.dirname(output),'raw-query.json'),JSON.stringify({synthetic:true,category}));
fs.writeFileSync(path.join(path.dirname(output),'submission.txt'),'synthetic answer');
const evidence=['raw-query.json','submission.txt'];
if(category==='evaluation-service'){
  fs.appendFileSync(path.join(__dirname,'../service-calls'),'service\\n');
  const kinds=['correct','incorrect','invalid','boundary'];
  const cases=kinds.map((kind,i)=>({id:'sample-'+i,caseId:'case-1',kind,submissionDigest:'sha256:'+require('node:crypto').createHash('sha256').update('submission-'+i).digest('hex'),status:i===2?'invalid':'completed',metrics:i===2?{}:{score:[1,0,0,0.5][i],passed:i===0}}));
  fs.writeFileSync(path.join(path.dirname(output),'service-scores.json'),JSON.stringify({schemaVersion:'benchmark-onboarding-scores/v1',benchmarkKey:'fixture',cases,aggregate:{mean:0.5}}));
  evidence.push('service-scores.json');
}
const evidenceDigests=Object.fromEntries(evidence.map(name=>[name,'sha256:'+require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(path.dirname(output),name))).digest('hex')]));
const facts=category==='evaluation-service'?{mode:'live',submissionSource:'frozen',scoresFile:'service-scores.json',serviceEvidence:{request:'raw-query.json',terminal:'raw-query.json',result:'raw-query.json'}}:category==='runtime'?{mode:'live',caseIds:['case-1'],steps:Object.fromEntries(['dataset','execution','submission','evaluation','evidence','cleanup'].map(step=>[step,{status:'pass',reference:'synthetic-'+step,evidence:['raw-query.json']}])),cases:[{caseId:'case-1',runId:'synthetic-run',evaluationId:'synthetic-evaluation',evaluatedRunId:'synthetic-run',submissionFile:'submission.txt',submissionDigest:evidenceDigests['submission.txt'],evaluatedSubmissionDigest:evidenceDigests['submission.txt'],executionEvidence:'raw-query.json',evaluationEvidence:'raw-query.json'}]}:{};
if(category==='evaluation-service'||category==='runtime'){
  facts.artifactPresentation={status:'not_checked',reason:'Synthetic fixture verifies downloads only'};
  const rows=category==='runtime'?facts.cases:JSON.parse(fs.readFileSync(path.join(path.dirname(output),'service-scores.json'))).cases.map(row=>({sampleId:row.id,caseId:row.caseId,evaluationId:'synthetic-evaluation-'+row.id,submissionDigest:row.submissionDigest}));
  facts.artifactChecks=rows.map((row,i)=>{
    const source='native-'+i+'.json',download='download-'+i+'.json',bytes=Buffer.from(JSON.stringify({synthetic:true,passed:i===0}));
    for(const file of [source,download]) {fs.writeFileSync(path.join(path.dirname(output),file),bytes);evidence.push(file);evidenceDigests[file]='sha256:'+require('node:crypto').createHash('sha256').update(bytes).digest('hex');}
    return {caseId:row.caseId,...(row.sampleId?{sampleId:row.sampleId}:{}),evaluationId:row.evaluationId,submissionDigest:row.submissionDigest,outputMode:'files',sourceEvidence:'raw-query.json',platformEvidence:'raw-query.json',mappingEvidence:'raw-query.json',outputs:[{name:'original result.json',source:'official-file',file:source}],attachments:[{name:'original result.json',source:'official-file',file:download,artifactId:'synthetic-artifact-'+i,sha256:evidenceDigests[download],sizeBytes:bytes.length}]};
  });
}
if(category==='runtime' && process.env.BENCHMARK_ONBOARDING_JOB_JOURNAL){
  const record=require(${JSON.stringify(path.join(C.skillRoot, 'scripts/record-job.cjs'))}).record;
  facts.cases[0].requestId='synthetic-case-1';
  for(const id of ['synthetic-case-1','synthetic-case-1:cleanup']) record(['--request-id',id,'--platform-id','synthetic-run','--state','completed','--evidence',path.join(path.dirname(output),'raw-query.json')]);
}
fs.writeFileSync(output,JSON.stringify({schemaVersion:'benchmark-onboarding-check/v1',status:'pass',evidence,evidenceDigests,facts}));
`)
  git(repo, ['init', '-q'])
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  const runRoot = path.join(root, 'runs')
  const limits = []
  if (options.maxAttempts !== undefined) limits.push('--max-attempts', String(options.maxAttempts))
  if (options.maxSeconds !== undefined) limits.push('--max-seconds', String(options.maxSeconds))
  const initial = await main(['init', '--repo', repo, '--project', repo, '--source', 'https://example.org/fixture', '--run-root', runRoot, '--id', 'test-run', ...limits])
  const directory = initial.directory
  const cmd = file => ({ argv: [process.execPath, `{repo}/${file}`, '{output}'], cwd: '{repo}', timeoutSeconds: 10 })
  const plan = {
    schemaVersion: 'benchmark-onboarding-plan/v1', benchmarkKey: 'fixture',
    scope: { label: 'Synthetic unit test only', mode: options.mode || 'live', caseIds: ['case-1'] },
    source: { url: 'https://example.org/fixture', codeRevision: 'fixture-v1', dataRevision: 'fixture-v1', split: 'test', license: 'synthetic', caseCount: 1 },
    analysisInputs: ['{repo}/protocol.md'],
    baselineInputs: ['{repo}/official.cjs', '{repo}/submissions.json', '{repo}/protocol.md'],
    implementationInputs: ['{repo}/check.cjs'],
    baseline: cmd('official.cjs'), tolerances: {},
    checks: ['source', 'visibility', 'interfaces', 'evaluation-service', 'regression', 'runtime'].map(id => ({
      id, category: ['interfaces', 'evaluation-service'].includes(id) ? 'regression' : id,
      ...(id === 'interfaces' ? { stage: 'interfaces' } : id === 'evaluation-service' ? { stage: 'evaluation' } : {}),
      dependsOn: id === 'interfaces' ? ['workflow', 'catalog', 'source', 'visibility'] : id === 'evaluation-service' ? ['interfaces'] : id === 'runtime' ? ['evaluation-service', 'regression'] : [],
      required: true, ...cmd('check.cjs'), argv: [...cmd('check.cjs').argv, id], resultMode: 'check',
    })),
  }
  const planPath = path.join(root, 'plan.json')
  write(planPath, plan)
  return { root, repo, directory, plan, planPath, freeze: () => main(['freeze', '--run', directory, '--plan', planPath]), verify: () => main(['verify', '--run', directory]), report: () => main(['report', '--run', directory]), state: () => C.readJson(path.join(directory, 'run.json')) }
}

test('independent score commands, target catalog, evidence and all required checks produce a structurally accepted unit fixture', async t => {
  const f = await fixture(t)
  assert.equal((await f.freeze()).status, 'pass')
  const report = await f.verify()
  assert.equal(report.status, 'accepted')
  const body = C.readJson(report.report)
  assert.equal(body.checks.find(c => c.stage === 'evaluation').scoreComparison.comparedSamples, 4)
  assert.equal(body.budget.usedAttempts, 2)
  assert.match(fs.readFileSync(report.markdown, 'utf8'), /accepted/)
  assert.match(fs.readFileSync(report.markdown, 'utf8'), /页面未验证（仅核对接口下载）/)
  assert.ok(body.checks.every(check => check.status === 'pass'))
})

test('compact packaged plan runs shared checks once while retaining scoring and runtime gates', async t => {
  const f = await fixture(t)
  const template = C.readJson(path.join(C.skillRoot, 'assets/templates/acceptance-plan.json'))
  const plan = {
    ...f.plan,
    checks: template.checks.map(spec => {
      const original = f.plan.checks.find(item => spec.stage === 'interfaces' ? item.stage === 'interfaces' : item.id === spec.id)
      assert.ok(original)
      return { ...spec, argv: original.argv }
    }),
  }
  plan.analysisInputs = ['{repo}/protocol.md']
  ensurePlan(plan)
  const calls = path.join(f.root, 'check-calls')
  const command = path.join(f.repo, 'check.cjs')
  fs.appendFileSync(command, `\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv[3] + '\\n')\n`)
  write(f.planPath, plan)
  await f.freeze()
  const report = C.readJson((await f.verify()).report)
  assert.equal(report.status, 'accepted')
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['source', 'visibility', 'interfaces', 'evaluation-service', 'runtime', 'regression'])
  assert.ok(report.checks.every(check => check.status === 'pass'))
  assert.ok(!report.checks.some(check => check.id === 'scoring'))
  assert.equal(fs.readFileSync(path.join(f.root, 'service-calls'), 'utf8'), 'service\n')
  const missingScoreGate = structuredClone(plan)
  missingScoreGate.checks.find(check => check.id === 'runtime').dependsOn = ['interface-contracts']
  assert.throws(() => ensurePlan(missingScoreGate), /runtime 缺少分层前置检查：evaluation/)
})

test('fixture mode never claims real integration acceptance', async t => {
  const f = await fixture(t, { mode: 'fixture' })
  await f.freeze()
  const result = await f.verify()
  assert.equal(result.status, 'needs_action')
  assert.match(result.limitations.join(' '), /Fixture/)
})

test('benchmark-specific sample labels and absent aggregate are allowed, missing or altered results still fail', async t => {
  const f = await fixture(t)
  await f.freeze()
  const official = C.readJson(f.state().baselines[0].scoresFile)
  official.cases = [{ ...official.cases[0], kind: 'official-example' }, { ...official.cases[1], kind: 'rejected-answer' }]
  delete official.aggregate
  assert.equal(compareScores(official, structuredClone(official), f.plan).status, 'pass')
  let candidate = structuredClone(official); candidate.cases.pop()
  assert.equal(compareScores(official, candidate, f.plan).status, 'fail')
  candidate = structuredClone(official); candidate.cases[0].metrics.score = 0
  assert.equal(compareScores(official, candidate, f.plan).status, 'fail')
  candidate = structuredClone(official); candidate.aggregate = { invented: 1 }
  assert.equal(compareScores(official, candidate, f.plan).status, 'fail')
})

test('changing only the validation plan reuses official output and one existing analysis record', async t => {
  const f = await fixture(t)
  await f.freeze()
  f.plan.checks.find(check => check.stage === 'evaluation').timeoutSeconds = 15
  write(f.planPath, f.plan)
  await main(['freeze', '--run', f.directory, '--plan', f.planPath, '--reason', 'adjust service timeout without changing official input'])
  assert.equal(f.state().baselines[1].reusedFrom, '0001')
  assert.equal(fs.readFileSync(path.join(f.root, 'official-calls'), 'utf8'), 'official\n')
  assert.equal((await f.verify()).status, 'accepted')
  fs.appendFileSync(path.join(f.repo, 'official.cjs'), '\n')
  await main(['freeze', '--run', f.directory, '--plan', f.planPath, '--reason', 'official source changed'])
  assert.equal(fs.readFileSync(path.join(f.root, 'official-calls'), 'utf8'), 'official\nofficial\n')
})

test('unrelated tracked changes and HEAD do not invalidate acceptance, related package files do', async t => {
  const f = await fixture(t)
  await f.freeze(); assert.equal((await f.verify()).status, 'accepted')
  write(path.join(f.repo, 'unrelated.txt'), 'documentation')
  git(f.repo, ['add', 'unrelated.txt'])
  git(f.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unrelated'])
  fs.appendFileSync(path.join(f.repo, 'unrelated.txt'), '\nmore documentation')
  assert.equal((await f.report()).status, 'accepted')
  write(path.join(f.repo, 'benchmarks/fixture/new-scorer.cjs'), 'module.exports = {}')
  assert.equal((await f.report()).status, 'needs_action')
  assert.equal((await f.freeze()).reused, true)
  assert.equal(fs.readFileSync(path.join(f.root, 'official-calls'), 'utf8'), 'official\n')
})

test('snapshots without the current verifier digest cannot be used to approve a run', async t => {
  const f = await fixture(t)
  await f.freeze(); assert.equal((await f.verify()).status, 'accepted')
  const state = f.state()
  const snapshot = state.attempts.at(-1).snapshot
  delete snapshot.verifierDigest
  assert.throws(() => C.snapshotDigest(snapshot), /不支持旧快照/)
  write(path.join(f.directory, 'run.json'), state)
  const report = await f.report()
  assert.equal(report.status, 'needs_action')
  assert.match(report.limitations.join('；'), /不支持旧快照/)
  assert.equal(fs.readFileSync(path.join(f.root, 'official-calls'), 'utf8'), 'official\n')
})

test('target-specific strict catalog bridge works without changing target exports', async t => {
  const f = await fixture(t)
  const target = path.join(f.repo, 'scripts/benchmark/generate-catalog.cjs')
  write(target, "exports.validateNewBenchmark = key => { if(key !== 'fixture') throw Error('invalid'); return {status:'pass',key,digest:'checked'} }")
  const bridge = path.join(f.repo, 'bridge.cjs')
  write(bridge, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(require('./scripts/benchmark/generate-catalog.cjs').validateNewBenchmark('fixture')))")
  f.plan.catalog = { argv: [process.execPath, '{repo}/bridge.cjs', '{output}'], cwd: '{repo}', timeoutSeconds: 5 }
  f.plan.implementationInputs.push('{repo}/bridge.cjs', '{repo}/scripts/benchmark/generate-catalog.cjs')
  write(f.planPath, f.plan)
  await f.freeze(); assert.equal((await f.verify()).status, 'accepted')
  write(target, "exports.validateNewBenchmark = () => { throw Error('manifest rejected') }")
  const body = C.readJson((await f.verify()).report)
  assert.equal(body.status, 'failed')
  assert.equal(body.checks.find(item => item.id === 'runtime').status, 'blocked')
})

test('delivery regression runs after runtime but its failure still prevents acceptance', async t => {
  const f = await fixture(t)
  const regression = f.plan.checks.find(item => item.id === 'regression')
  f.plan.checks = f.plan.checks.filter(item => item !== regression)
  f.plan.checks.find(item => item.category === 'runtime').dependsOn = ['evaluation-service']
  Object.assign(regression, { stage: 'delivery', dependsOn: ['runtime'], resultMode: 'exit-code', argv: [process.execPath, '-e', 'process.exit(7)'] })
  f.plan.checks.push(regression)
  write(f.planPath, f.plan)
  await f.freeze()
  const result = C.readJson((await f.verify()).report)
  assert.equal(result.status, 'failed')
  assert.equal(result.checks.find(item => item.id === 'runtime').status, 'pass')
  assert.equal(result.checks.find(item => item.id === 'regression').exitCode, 7)
  const state = f.state()
  state.attempts.at(-1).checks = state.attempts.at(-1).checks.filter(item => item.id !== 'regression')
  write(path.join(f.directory, 'run.json'), state)
  const incomplete = await f.report()
  assert.equal(incomplete.status, 'needs_action')
  assert.match(incomplete.limitations.join(' '), /缺少计划中的必需检查：regression/)
  const noRuntimeDependency = structuredClone(f.plan)
  noRuntimeDependency.checks.at(-1).dependsOn = ['evaluation-service']
  assert.throws(() => ensurePlan(noRuntimeDependency), /交付回归必须依赖/)
})

test('interface failure still blocks runtime with a delivery regression', async t => {
  const f = await fixture(t)
  const regression = f.plan.checks.find(item => item.id === 'regression')
  f.plan.checks = f.plan.checks.filter(item => item !== regression)
  f.plan.checks.find(item => item.category === 'runtime').dependsOn = ['evaluation-service']
  Object.assign(regression, { stage: 'delivery', dependsOn: ['runtime'] })
  f.plan.checks.push(regression)
  f.plan.checks.find(item => item.stage === 'interfaces').argv = [process.execPath, '-e', 'process.exit(3)']
  write(f.planPath, f.plan)
  await f.freeze()
  const result = C.readJson((await f.verify()).report)
  assert.equal(result.status, 'failed')
  assert.equal(result.checks.find(item => item.id === 'runtime').status, 'blocked')
  assert.equal(result.checks.find(item => item.id === 'regression').status, 'blocked')
  assert.equal(f.state().jobs.length, 0)
})

test('raw operation survives a validator repair without executing twice; current checks still run', async t => {
  const f = await fixture(t)
  const input = path.join(f.root, 'execution-input.json')
  const raw = path.join(f.root, 'response.json')
  write(input, { model: 'fixture', deployment: 'v1' }); write(raw, { runId: 'r1', answer: 'a' })
  let executions = 0, validations = 0
  const options = {
    directory: path.join(f.directory, 'recorded/execution'),
    identity: { project: f.repo, benchmarkKey: 'fixture', operation: 'execution', caseId: 'case-1' },
    inputs: [input],
    execute: async () => { executions++; return { value: { runId: 'r1' }, files: [raw] } },
    validate: async () => { validations++; throw new Error('conversion defect') },
  }
  await assert.rejects(recordedOperation(options), /conversion defect/)
  options.validate = async ({ value, reused }) => { validations++; assert.equal(value.runId, 'r1'); assert.equal(reused, true); return true }
  const record = await recordedOperation(options)
  assert.equal(executions, 1); assert.equal(validations, 2)
  const copied = copyRecordedEvidence(record, path.join(f.root, 'fresh-attempt'))
  assert.equal(copied.evidence.length, 2)
  assert.deepEqual(C.readJson(path.join(f.root, 'fresh-attempt', copied.files[0])), { runId: 'r1', answer: 'a' })
  options.validate = async () => false
  await assert.rejects(recordedOperation(options), /当前有效性/)
  assert.equal(executions, 1)
})

test('recorded operation rejects input, identity and raw evidence drift without re-execution', async t => {
  const f = await fixture(t)
  const input = path.join(f.root, 'operation-input.json'), raw = path.join(f.root, 'raw.json')
  write(input, { scorer: 'v1' }); write(raw, { score: 1 })
  let calls = 0
  const options = { directory: path.join(f.directory, 'recorded/scoring'), identity: { project: f.repo, benchmarkKey: 'fixture', operation: 'scoring' }, inputs: [input], execute: async () => { calls++; return { value: { score: 1 }, files: [raw] } }, validate: async () => true }
  const first = await recordedOperation(options)
  write(input, { scorer: 'v2' })
  await assert.rejects(recordedOperation(options), /输入已变化/)
  write(input, { scorer: 'v1' })
  await assert.rejects(recordedOperation({ ...options, identity: { ...options.identity, operation: 'execution' } }), /身份或输入/)
  write(first.files[0], { score: 0 })
  await assert.rejects(recordedOperation(options), /摘要不匹配/)
  assert.equal(calls, 1)
})

test('unknown operation and input changes during execution never cause an automatic retry', async t => {
  const f = await fixture(t)
  const input = path.join(f.root, 'input.json'), raw = path.join(f.root, 'raw.json')
  write(input, 'v1'); write(raw, {})
  let calls = 0
  const options = { directory: path.join(f.directory, 'recorded/unknown'), identity: { project: f.repo, benchmarkKey: 'fixture', operation: 'execute' }, inputs: [input], execute: async () => { calls++; throw new Error('submission unknown') }, validate: async () => true }
  await assert.rejects(recordedOperation(options), /submission unknown/)
  await assert.rejects(recordedOperation(options), /原始操作未完成/)
  assert.equal(calls, 1)
  const changed = { ...options, directory: path.join(f.directory, 'recorded/changed'), execute: async () => { calls++; write(input, 'v2'); return { value: {}, files: [raw] } } }
  await assert.rejects(recordedOperation(changed), /执行期间操作输入变化/)
  await assert.rejects(recordedOperation(changed), /原始操作未完成/)
  assert.equal(calls, 2)
})

test('a new verify attempt rechecks recorded runtime evidence after converter repair without another execution', async t => {
  const f = await fixture(t)
  const driver = path.join(f.repo, 'recorded-driver.cjs')
  const calls = path.join(f.root, 'runtime-calls')
  const code = `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const C=require(${JSON.stringify(path.join(C.skillRoot, 'scripts/common.cjs'))});
const {recordedOperation,copyRecordedEvidence}=require(${JSON.stringify(path.join(C.skillRoot, 'scripts/recorded-operation.cjs'))});
const output=process.argv[2], attempt=path.dirname(output);
(async()=>{
 const record=await recordedOperation({
  directory:${JSON.stringify(path.join(f.directory, 'recorded/runtime'))},
  identity:{project:__dirname,benchmarkKey:'fixture',operation:'runtime'},
  inputs:[path.join(__dirname,'check.cjs'),path.join(__dirname,'submissions.json')],
  execute:async()=>{
   fs.appendFileSync(${JSON.stringify(calls)},'execute\\n');
   const rawDir=path.join(attempt,'captured');fs.mkdirSync(rawDir);
   const rawOutput=path.join(rawDir,'result.json');
   cp.execFileSync(process.execPath,[path.join(__dirname,'check.cjs'),rawOutput,'runtime']);
   const value=C.readJson(rawOutput);return {value,files:value.evidence.map(name=>path.join(rawDir,name))};
  },
  validate:async()=>true
 });
 if (true) throw Error('converter repair needed');
 const copied=copyRecordedEvidence(record,attempt);
 const names=new Map(record.value.evidence.map((name,i)=>[name,copied.files[i]]));
 const remap=value=>typeof value==='string'?(names.get(value)||value):Array.isArray(value)?value.map(remap):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[names.get(k)||k,remap(v)])):value;
 const result=remap(record.value);result.evidence=copied.evidence;
 result.evidenceDigests=Object.fromEntries(result.evidence.map(name=>[name,C.fileHash(path.join(attempt,name))]));
 C.atomicJson(output,result);
})().catch(e=>{console.error(e.message);process.exitCode=1});
`
  write(driver, code)
  f.plan.implementationInputs.push('{repo}/recorded-driver.cjs')
  f.plan.checks.find(item => item.category === 'runtime').argv = [process.execPath, '{repo}/recorded-driver.cjs', '{output}']
  write(f.planPath, f.plan)
  await f.freeze()
  assert.equal((await f.verify()).status, 'failed')
  write(driver, code.replace('if (true) throw', 'if (false) throw'))
  assert.equal((await f.verify()).status, 'accepted')
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['execute'])
  assert.equal(f.state().jobs.filter(job => !job.requestId.endsWith(':cleanup')).length, 1)
})

test('onboarding cannot fall back to a legacy catalog loader without the strict entrypoint', async t => {
  const f = await fixture(t)
  const generator = path.join(f.repo, 'scripts/benchmark/generate-catalog.cjs')
  fs.writeFileSync(generator, fs.readFileSync(generator, 'utf8').replace('loadPackageForOnboarding', 'loadPackage'))
  await f.freeze()
  const body = C.readJson((await f.verify()).report)
  assert.equal(body.status, 'failed')
  const catalog = body.checks.find(check => check.id === 'catalog')
  assert.equal(catalog.status, 'fail')
  const output = catalog.evidence.find(file => path.basename(file.path) === 'stdout.log')
  assert.match(C.readJson(output.path).reason, /未导出 loadPackageForOnboarding/)
  assert.equal(body.checks.find(check => check.id === 'runtime').status, 'blocked')
  assert.equal(fs.existsSync(path.join(f.root, 'service-calls')), false)
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

test('an incorrect service score fails while retaining official baseline and both attempts', async t => {
  const f = await fixture(t)
  await f.freeze()
  const file = path.join(f.repo, 'check.cjs'), original = fs.readFileSync(file, 'utf8')
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
  write(file, original.replace("category==='runtime'?{mode:'live'", "category==='runtime'?{mode:'mock'"))
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
  fs.appendFileSync(path.join(f.repo, 'check.cjs'), '\n')
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

async function trackedFixture(t) {
  const f = await fixture(t)
  const state = f.state(); state.attempts.push({ id: '0001', status: 'running', checks: [] })
  write(path.join(f.directory, 'run.json'), state)
  const journal = path.join(f.directory, 'attempts/0001/runtime/platform-jobs')
  const evidence = path.join(f.root, 'task.json'), cleanupEvidence = path.join(f.root, 'cleanup.json')
  write(evidence, { synthetic: true, id: 'platform-run', state: 'completed' })
  write(cleanupEvidence, { synthetic: true, remainingResources: [] })
  const counts = { submit: 0, query: 0, cleanup: 0 }
  const options = {
    run: f.directory, journal, caseId: 'case-1', operation: 'execute', inputDigest: C.hash('frozen inputs'),
    submit: async ({ requestId }) => {
      counts.submit++
      const saved = reconcile(f.directory, f.state())
      assert.equal(saved.jobs.find(job => job.requestId === requestId).state, 'unknown')
      assert.equal(saved.jobs.find(job => job.requestId === `${requestId}:cleanup`).state, 'unknown')
      return { platformId: 'platform-run' }
    },
    query: async () => { counts.query++; return { platformId: 'platform-run', state: 'completed', evidence } },
    cleanup: async () => { counts.cleanup++; return { platformId: 'platform-run', state: 'completed', taskEvidence: evidence, evidence: cleanupEvidence } },
  }
  return { f, options, counts }
}

test('tracked tasks register before submit and recover without resubmitting or repeating confirmed cleanup', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const first = await trackedJob(options)
  const second = await trackedJob(options)
  assert.equal(first.requestId, second.requestId)
  assert.deepEqual(counts, { submit: 1, query: 2, cleanup: 1 })
  const saved = reconcile(f.directory, f.state())
  assert.equal(saved.jobs.length, 2)
  assert.ok(saved.jobs.every(job => job.state === 'completed' && job.platformId === 'platform-run'))
})

test('unknown submission response is recovered by query rather than a second submit', async t => {
  const { options, counts } = await trackedFixture(t)
  const submit = options.submit
  options.submit = async context => { await submit(context); throw new Error('response lost') }
  await assert.rejects(trackedJob(options), /response lost/)
  const result = await trackedJob(options)
  assert.equal(result.platformId, 'platform-run')
  assert.deepEqual(counts, { submit: 1, query: 1, cleanup: 1 })
})

test('unconfirmed cleanup blocks a different request and can be recovered without resubmitting', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const cleanup = options.cleanup
  options.cleanup = async () => { throw new Error('cleanup unavailable') }
  await assert.rejects(trackedJob(options), /清理尚未确认/)
  assert.ok(reconcile(f.directory, f.state()).jobs.some(job => job.requestId.endsWith(':cleanup') && job.state === 'unknown'))
  await assert.rejects(trackedJob({ ...options, inputDigest: C.hash('changed inputs') }), /其他未确认/)
  options.cleanup = cleanup
  await trackedJob(options)
  assert.deepEqual(counts, { submit: 1, query: 2, cleanup: 1 })
})

test('query failures still invoke cleanup and preserve the original failure', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const cancelledEvidence = path.join(f.root, 'cancelled.json')
  write(cancelledEvidence, { synthetic: true, state: 'cancelled' })
  options.query = async () => { counts.query++; throw new Error('query timeout') }
  options.cleanup = async () => { counts.cleanup++; return { platformId: 'platform-run', state: 'cancelled', taskEvidence: cancelledEvidence, evidence: cancelledEvidence } }
  await assert.rejects(trackedJob(options), /query timeout/)
  const saved = reconcile(f.directory, f.state())
  assert.equal(saved.jobs.find(job => !job.requestId.endsWith(':cleanup')).state, 'cancelled')
  assert.equal(saved.jobs.find(job => job.requestId.endsWith(':cleanup')).state, 'completed')
  assert.deepEqual(counts, { submit: 1, query: 1, cleanup: 1 })
})

test('target state mapping ends failed tasks promptly and preserves raw status without hardcoded platform enums', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const query = options.query, cleanup = options.cleanup
  options.query = async args => ({ ...await query(args), state: 'target-rejected' })
  options.cleanup = async args => ({ ...await cleanup(args), state: 'target-rejected' })
  options.mapState = state => ({ 'target-rejected': 'failed' })[state]
  await assert.rejects(trackedJob(options), /任务尚未成功完成：failed/)
  const state = reconcile(f.directory, f.state())
  const task = state.jobs.find(job => !job.requestId.endsWith(':cleanup'))
  assert.equal(task.state, 'failed'); assert.equal(task.rawState, 'target-rejected')
  assert.equal(state.jobs.find(job => job.requestId.endsWith(':cleanup')).state, 'completed')
  assert.deepEqual(counts, { submit: 1, query: 1, cleanup: 1 })
  assert.throws(() => normalizeState('new-target-state', options.mapState), /平台状态未适配/)
})

test('unmapped target status remains recoverable without a duplicate submission', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const query = options.query, cleanup = options.cleanup
  options.query = async args => ({ ...await query(args), state: 'new-target-terminal' })
  options.cleanup = async args => ({ ...await cleanup(args), state: 'new-target-terminal' })
  await assert.rejects(trackedJob(options), /平台状态未适配/)
  let saved = reconcile(f.directory, f.state())
  const task = saved.jobs.find(job => !job.requestId.endsWith(':cleanup'))
  assert.equal(task.state, 'unknown'); assert.equal(task.rawState, 'new-target-terminal')
  options.mapState = state => state === 'new-target-terminal' ? 'completed' : undefined
  const result = await trackedJob(options)
  assert.equal(result.state, 'completed')
  assert.equal(counts.submit, 1)
  saved = reconcile(f.directory, f.state())
  assert.ok(saved.jobs.every(job => job.state === 'completed'))
})

test('each query is mapped before polling again and normalization failure ends the wait', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const query = options.query, cleanup = options.cleanup
  options.pollIntervalMs = 1
  options.query = async args => ({ ...await query(args), state: counts.query === 1 ? 'normalizing' : 'normalization_failed' })
  options.cleanup = async args => ({ ...await cleanup(args), state: 'normalization_failed' })
  options.mapState = state => ({ normalizing: 'running', normalization_failed: 'failed' })[state]
  await assert.rejects(trackedJob(options), /任务尚未成功完成：failed/)
  assert.deepEqual(counts, { submit: 1, query: 2, cleanup: 1 })
  const task = reconcile(f.directory, f.state()).jobs.find(job => !job.requestId.endsWith(':cleanup'))
  assert.deepEqual(task.history.slice(-3).map(event => event.state), ['running', 'failed', 'failed'])
  assert.equal(task.rawState, 'normalization_failed')
})

test('standalone evaluator polling stops on an omitted terminal mapping and preserves the raw response', async () => {
  let calls = 0
  const observed = []
  await assert.rejects(waitForJob({
    query: async () => ({ state: ++calls === 1 ? 'normalizing' : 'normalization_failed', reason: 'identity mismatch' }),
    mapState: state => state === 'normalizing' ? 'running' : undefined,
    pollIntervalMs: 1,
    onObservation: value => observed.push(value),
  }), /平台状态未适配：normalization_failed/)
  assert.equal(calls, 2)
  assert.equal(observed[1].rawState, 'normalization_failed')
  assert.equal(observed[1].reason, 'identity mismatch')
  assert.equal(observed[1].state, 'unknown')
})

test('a query that never returns is bounded, aborted and followed by cleanup', async t => {
  const { options, counts } = await trackedFixture(t)
  let querySignal
  options.requestTimeoutMs = 30
  options.query = ({ signal }) => { counts.query++; querySignal = signal; return new Promise(() => {}) }
  const start = performance.now()
  await assert.rejects(trackedJob(options), /任务查询超时/)
  assert.ok(performance.now() - start < 2000)
  assert.equal(querySignal.aborted, true)
  assert.deepEqual(counts, { submit: 1, query: 1, cleanup: 1 })
})

test('a perpetually running job reaches its deadline and cleanup has its own bound', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const query = options.query
  options.query = async args => ({ ...await query(args), state: 'running' })
  options.timeoutMs = 25; options.pollIntervalMs = 1; options.cleanupTimeoutMs = 25
  let cleanupSignal
  options.cleanup = ({ signal }) => { counts.cleanup++; cleanupSignal = signal; return new Promise(() => {}) }
  await assert.rejects(trackedJob(options), /任务.*超时.*清理尚未确认.*清理超时/)
  assert.equal(cleanupSignal.aborted, true)
  assert.equal(counts.cleanup, 1)
  assert.ok(reconcile(f.directory, f.state()).jobs.some(job => job.state === 'unknown'))
  await assert.rejects(trackedJob({ ...options, operation: 'new attempt' }), /其他未确认/)
  assert.equal(counts.submit, 1)
})

test('confirmed rejection closes task and cleanup without a fabricated platform id or automatic resubmission', async t => {
  const { f, options, counts } = await trackedFixture(t)
  const submit = options.submit
  options.submit = async args => {
    await submit(args)
    const evidence = path.join(f.root, 'rejection.json')
    write(evidence, { requestId: args.requestId, taskCreated: false, contract: 'fixture validates before creating resources', response: { status: 400, body: { code: 'INVALID_TARGET' } } })
    return { rejected: true, evidence }
  }
  await assert.rejects(trackedJob(options), /提交已明确拒绝/)
  await assert.rejects(trackedJob(options), /提交已明确拒绝/)
  const saved = reconcile(f.directory, f.state())
  assert.deepEqual(saved.jobs.map(job => job.state), ['failed', 'completed'])
  assert.ok(saved.jobs.every(job => job.notCreated === true && job.platformId === null))
  assert.deepEqual(counts, { submit: 1, query: 0, cleanup: 0 })
  const status = await main(['status', '--run', f.directory])
  assert.equal(status.resume.pendingJobs.length, 0)
  options.submit = submit
  await trackedJob({ ...options, operation: 'execute-after-fixing-target' })
  assert.deepEqual(counts, { submit: 2, query: 1, cleanup: 1 })
})

test('manual rejection recovery validates evidence and finishes an interrupted no-resource cleanup', async t => {
  const { f, options, counts } = await trackedFixture(t)
  options.submit = async () => { counts.submit++; throw new Error('response lost') }
  await assert.rejects(trackedJob(options), /response lost/)
  const task = reconcile(f.directory, f.state()).jobs.find(job => !job.requestId.endsWith(':cleanup'))
  const evidence = path.join(f.root, 'queried-rejection.json')
  write(evidence, { requestId: task.requestId, taskCreated: false, contract: 'fixture request lookup confirms rejection without resources', response: { code: 'REJECTED' } })
  await main(['job', '--run', f.directory, '--request-id', task.requestId, '--state', 'failed', '--not-created', 'true', '--evidence', evidence])
  await assert.rejects(trackedJob(options), /提交已明确拒绝/)
  assert.ok(reconcile(f.directory, f.state()).jobs.every(job => ['failed', 'completed'].includes(job.state)))
  assert.deepEqual(counts, { submit: 1, query: 0, cleanup: 0 })
})

test('HTTP errors without proof of no task and mismatched rejection evidence remain unknown', async t => {
  for (const proof of [{ response: { status: 400 } }, { requestId: 'another-request', taskCreated: false, contract: 'fixture', response: { status: 400 } }]) {
    const { f, options, counts } = await trackedFixture(t)
    options.submit = async () => {
      counts.submit++
      const evidence = path.join(f.root, 'unproven-rejection.json')
      write(evidence, proof)
      return { rejected: true, evidence }
    }
    await assert.rejects(trackedJob(options), /拒绝证据需要/)
    assert.ok(reconcile(f.directory, f.state()).jobs.every(job => job.state === 'unknown'))
    await assert.rejects(trackedJob({ ...options, operation: 'another-request' }), /其他未确认/)
    assert.equal(counts.submit, 1)
  }
})

test('an existing platform task cannot be relabeled as a rejected submission', async t => {
  const { f, options } = await trackedFixture(t)
  const result = await trackedJob(options)
  const evidence = path.join(f.root, 'false-rejection.json')
  write(evidence, { requestId: result.requestId, taskCreated: false, contract: 'fixture', response: { status: 409 } })
  await assert.rejects(main(['job', '--run', f.directory, '--request-id', result.requestId, '--state', 'failed', '--not-created', 'true', '--evidence', evidence]), /不能提供平台 ID|已有平台任务 ID/)
  assert.equal(reconcile(f.directory, f.state()).jobs.find(job => job.requestId === result.requestId).state, 'completed')
})

test('full runtime verification rejects a Case without its task registration reference', async t => {
  const f = await fixture(t)
  fs.appendFileSync(path.join(f.repo, 'check.cjs'), `\nif(category==='runtime'){const value=JSON.parse(fs.readFileSync(output));delete value.facts.cases[0].requestId;fs.writeFileSync(output,JSON.stringify(value));}\n`)
  await f.freeze()
  const body = C.readJson((await f.verify()).report)
  assert.equal(body.checks.find(check => check.id === 'runtime').status, 'fail')
  assert.match(body.checks.find(check => check.id === 'runtime').reason, /任务及清理登记/)
})

test('an interrupted child task journal is read on resume and blocks duplicate submission', async t => {
  const f = await fixture(t)
  await f.freeze()
  const file = path.join(f.repo, 'check.cjs')
  fs.appendFileSync(file, `\nif (category === 'runtime') require(${JSON.stringify(path.join(C.skillRoot, 'scripts/record-job.cjs'))}).record(['--request-id','child-1','--state','unknown']);\n`)
  const result = await f.verify()
  assert.equal(result.status, 'needs_action')
  assert.equal(f.state().jobs.find(job => job.requestId === 'child-1').state, 'unknown')
  await assert.rejects(f.verify(), /在途/)
  const evidence = path.join(f.root, 'job-query.json')
  write(evidence, { id: 'platform-1', status: 'completed', synthetic: true })
  await main(['job', '--run', f.directory, '--request-id', 'child-1', '--platform-id', 'platform-1', '--state', 'completed', '--evidence', evidence])
  assert.equal((await main(['resume', '--run', f.directory])).resume.pendingJobs.length, 0)
  assert.equal((await main(['resume', '--run', f.directory])).jobs.find(job => job.requestId === 'child-1').history.length, 2)
  const journal = path.join(f.directory, 'attempts', '0001', 'runtime', 'platform-jobs')
  record(['--request-id', 'child-2', '--state', 'unknown'], journal)
  assert.equal(f.state().jobs.filter(job => job.requestId.startsWith('child-')).length, 1)
  const resumed = await main(['resume', '--run', f.directory])
  assert.equal(resumed.resume.pendingJobs[0].requestId, 'child-2')
  assert.equal(f.state().jobs.filter(job => job.requestId.startsWith('child-')).length, 1)
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
  await f.report()
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

test('default runs remain usable beyond the former attempt and wall-clock limits', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.state().budget, {})
  const state = f.state()
  state.createdAt = '2000-01-01T00:00:00.000Z'
  write(path.join(f.directory, 'run.json'), state)
  await f.freeze()
  for (let i = 0; i < 5; i++) assert.equal((await f.verify()).status, 'accepted')
  const resumed = await main(['resume', '--run', f.directory])
  assert.equal(resumed.budget.usedAttempts, 6)
  assert.equal(resumed.resume.budgetReason, null)
  assert.equal(resumed.budget.maxAttempts, undefined)
  assert.equal(resumed.budget.maxSeconds, undefined)
})

test('explicit elapsed-time limit survives resume and can be removed without resetting history', async t => {
  const f = await fixture(t, { maxSeconds: 600, maxAttempts: 1 })
  await f.freeze()
  const state = f.state()
  state.createdAt = '2000-01-01T00:00:00.000Z'
  write(path.join(f.directory, 'run.json'), state)
  await assert.rejects(f.verify(), /总耗时预算/)
  await main(['budget', '--run', f.directory, '--max-seconds', 'unlimited', '--reason', 'user removed elapsed-time limit'])
  assert.deepEqual(f.state().budget, { maxAttempts: 1 })
  await assert.rejects(f.verify(), /运行尝试预算/)
  await main(['budget', '--run', f.directory, '--max-attempts', 'unlimited', '--reason', 'user removed attempt limit'])
  assert.deepEqual(f.state().budget, {})
  assert.equal(f.state().createdAt, state.createdAt)
  assert.equal(f.state().baselines.length, 1)
  assert.equal(f.state().budgetHistory.length, 2)
  assert.deepEqual(f.state().budgetHistory[0].previous, { maxSeconds: 600, maxAttempts: 1 })
  assert.equal((await f.verify()).status, 'accepted')
})

test('invalid explicit limits are rejected without changing the saved run', async t => {
  const f = await fixture(t)
  const before = f.state()
  for (const value of ['0', '-1', '1.5', 'invalid', 'Infinity']) {
    await assert.rejects(main(['budget', '--run', f.directory, '--max-attempts', value, '--reason', 'invalid fixture']), /数字/)
    await assert.rejects(main(['budget', '--run', f.directory, '--max-seconds', value, '--reason', 'invalid fixture']), /数字/)
  }
  await assert.rejects(main(['budget', '--run', f.directory, '--reason', 'missing limit']), /至少/)
  assert.deepEqual(f.state(), before)
})

test('unconfigured official command is blocked and cannot create an accepted baseline', async t => {
  const f = await fixture(t)
  f.plan.baseline.argv = []
  write(f.planPath, f.plan)
  assert.equal((await f.freeze()).status, 'blocked')
  assert.equal(f.state().activeBaseline, undefined)
  assert.equal((await f.report()).status, 'needs_action')
})

test('schema rejects weak modes, duplicated checks, removed score entrypoints and invalid timeouts', async t => {
  const f = await fixture(t)
  const clone = () => structuredClone(f.plan)
  let plan = clone(); plan.checks[0].resultMode = 'exit-code'; assert.throws(() => ensurePlan(plan), /仅回归/)
  plan = clone(); plan.checks.push(plan.checks[0]); assert.throws(() => ensurePlan(plan), /重复/)
  plan = clone(); plan.candidate = plan.baseline; assert.throws(() => ensurePlan(plan), /candidate 评分入口已移除/)
  plan = clone(); plan.baseline.timeoutSeconds = -1; assert.throws(() => ensurePlan(plan), /数字/)
  plan = clone(); plan.scope.mode = 'fake-live'; assert.throws(() => ensurePlan(plan), /允许范围/)
  plan = clone(); plan.checks[0].dependsOn = ['missing']; assert.throws(() => ensurePlan(plan), /依赖必须/)
  plan = clone(); plan.checks[0].dependsOn = ['runtime']; assert.throws(() => ensurePlan(plan), /依赖必须/)
  plan = clone(); plan.checks[0].dependsOn = ['source']; assert.throws(() => ensurePlan(plan), /依赖必须/)
  plan = clone(); delete plan.checks.find(c => c.id === 'runtime').dependsOn; assert.throws(() => ensurePlan(plan), /缺少前置/)
  plan = clone(); delete plan.checks.find(c => c.id === 'interfaces').stage; assert.throws(() => ensurePlan(plan), /依赖接口/)
})

test('failed interface check blocks service and runtime commands but retains the actual failure', async t => {
  const f = await fixture(t)
  const marker = path.join(f.root, 'should-not-run')
  f.plan.checks.find(c => c.id === 'interfaces').argv = [process.execPath, '-e', 'process.exit(1)']
  for (const id of ['evaluation-service', 'runtime']) f.plan.checks.find(c => c.id === id).argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`]
  write(f.planPath, f.plan); await f.freeze()
  const body = C.readJson((await f.verify()).report)
  assert.equal(body.checks.find(c => c.id === 'interfaces').status, 'fail')
  for (const id of ['evaluation-service', 'runtime']) {
    const check = body.checks.find(c => c.id === id)
    assert.equal(check.status, 'blocked'); assert.match(check.reason, /interfaces/)
  }
  assert.equal(fs.existsSync(marker), false)
})

test('health or function-only score result cannot unblock a real runtime check', async t => {
  const f = await fixture(t)
  const marker = path.join(f.root, 'runtime-started')
  f.plan.checks.find(c => c.id === 'evaluation-service').argv = [...f.plan.checks[0].argv, 'source']
  f.plan.checks.find(c => c.id === 'runtime').argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`]
  write(f.planPath, f.plan); await f.freeze()
  const body = C.readJson((await f.verify()).report)
  assert.equal(body.checks.find(c => c.id === 'evaluation-service').status, 'fail')
  assert.match(body.checks.find(c => c.id === 'evaluation-service').reason, /实际服务/)
  assert.equal(body.checks.find(c => c.id === 'runtime').status, 'blocked')
  assert.equal(fs.existsSync(marker), false)
})

test('O2 service results are compared to the frozen official baseline with no duplicate invocation', async t => {
  const f = await fixture(t)
  await f.freeze()
  const body = C.readJson((await f.verify()).report)
  const service = body.checks.find(c => c.id === 'evaluation-service')
  assert.equal(service.status, 'pass')
  assert.deepEqual(service.scoreComparison, { status: 'pass', comparedSamples: 4, differences: [] })
  const count = name => fs.readFileSync(path.join(f.root, name), 'utf8').trim().split('\n').length
  assert.equal(count('official-calls'), 1)
  assert.equal(count('service-calls'), 1)
  const spec = f.plan.checks.find(check => check.id === 'evaluation-service')
  assert.equal(inspectCheck(C.readJson(service.output), spec, { attempt: path.dirname(service.output), output: service.output, officialScoresFile: f.state().baselines[0].scoresFile }, f.plan).scoreComparison.status, 'pass')
  assert.equal(count('official-calls'), 1)
  assert.equal(count('service-calls'), 1)
  assert.equal(f.state().attempts.length, 1)
})

test('a wrong deployed service score blocks Agent execution', async t => {
  const f = await fixture(t)
  const marker = path.join(f.root, 'runtime-started')
  fs.appendFileSync(path.join(f.repo, 'check.cjs'), `
if(category==='evaluation-service'){
  const file=path.join(path.dirname(output),'service-scores.json');
  const scores=JSON.parse(fs.readFileSync(file));scores.cases[0].metrics.score=0;
  fs.writeFileSync(file,JSON.stringify(scores));
  const result=JSON.parse(fs.readFileSync(output));result.evidenceDigests['service-scores.json']='sha256:'+require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(output,JSON.stringify(result));
}
`)
  f.plan.checks.find(c => c.id === 'runtime').argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`]
  write(f.planPath, f.plan); await f.freeze()
  const body = C.readJson((await f.verify()).report)
  const service = body.checks.find(c => c.id === 'evaluation-service')
  assert.equal(service.status, 'fail')
  assert.match(service.reason, /官方基线不一致/)
  assert.equal(service.scoreComparison.comparedSamples, 4)
  assert.equal(body.checks.find(c => c.id === 'runtime').status, 'blocked')
  assert.equal(fs.existsSync(marker), false)
  assert.equal(fs.readFileSync(path.join(f.root, 'service-calls'), 'utf8'), 'service\n')
})

test('service comparison requires score evidence and rejects mismatched identities, metrics and coverage locally', async t => {
  const f = await fixture(t)
  await f.freeze()
  const attempt = path.join(f.root, 'saved-service')
  const output = path.join(attempt, 'result.json')
  await runCommand({ argv: [process.execPath, '{repo}/check.cjs', '{output}', 'evaluation-service'], cwd: '{repo}', timeoutSeconds: 5 }, { repo: f.repo, attempt })
  const value = C.readJson(output), original = C.readJson(path.join(attempt, 'service-scores.json'))
  const spec = f.plan.checks.find(c => c.id === 'evaluation-service')
  const context = { attempt, output, officialScoresFile: f.state().baselines[0].scoresFile }
  const inspect = body => inspectCheck(body, spec, context, f.plan)
  assert.throws(() => inspectCheck(value, spec, { attempt, output }, f.plan), /官方评分基线/)
  let body = structuredClone(value); delete body.facts.scoresFile; assert.throws(() => inspect(body), /scoresFile/)
  body = structuredClone(value); body.facts.scoresFile = '../outside.json'; assert.throws(() => inspect(body), /scoresFile/)
  for (const mutate of [
    scores => { scores.cases[0].submissionDigest = C.hash('wrong submission') },
    scores => { scores.cases[0].id = 'wrong-id' },
    scores => { scores.cases.pop() },
    scores => { scores.cases[0].status = 'invalid' },
    scores => { scores.aggregate.mean = 0.9 },
  ]) {
    const scores = structuredClone(original); mutate(scores)
    write(path.join(attempt, 'service-scores.json'), scores)
    body = structuredClone(value); body.evidenceDigests['service-scores.json'] = C.fileHash(path.join(attempt, 'service-scores.json'))
    assert.equal(inspect(body).status, 'fail')
  }
  for (const mutate of [
    scores => { scores.cases[0].caseId = 'wrong-case' },
    scores => { scores.cases[0].status = 'infrastructure_error' },
  ]) {
    const scores = structuredClone(original); mutate(scores)
    write(path.join(attempt, 'service-scores.json'), scores)
    body = structuredClone(value); body.evidenceDigests['service-scores.json'] = C.fileHash(path.join(attempt, 'service-scores.json'))
    assert.throws(() => inspect(body))
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'service-calls'), 'utf8'), 'service\n')
})

test('version changes after prerequisite checks stop runtime before its command starts', async t => {
  const f = await fixture(t)
  const marker = path.join(f.root, 'runtime-started')
  const check = f.plan.checks.find(c => c.id === 'regression')
  check.argv = [process.execPath, '-e', `require('node:fs').appendFileSync('check.cjs','\\n')`]
  check.resultMode = 'exit-code'
  f.plan.checks.find(c => c.id === 'runtime').argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`]
  write(f.planPath, f.plan); await f.freeze()
  const body = C.readJson((await f.verify()).report)
  assert.match(body.checks.find(c => c.id === 'runtime').reason, /输入或版本已变化/)
  assert.equal(fs.existsSync(marker), false)
})

test('changed prerequisite evidence stops runtime even without source changes', async t => {
  const f = await fixture(t)
  const marker = path.join(f.root, 'runtime-started')
  const check = f.plan.checks.find(c => c.id === 'regression')
  check.argv = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(path.join(f.directory, 'attempts/0001/source/raw-query.json'))},'changed')`]
  check.resultMode = 'exit-code'
  f.plan.checks.find(c => c.id === 'runtime').argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`]
  write(f.planPath, f.plan); await f.freeze()
  const body = C.readJson((await f.verify()).report)
  assert.match(body.checks.find(c => c.id === 'runtime').reason, /证据已变化/)
  assert.equal(fs.existsSync(marker), false)
})

test('score comparison checks IDs, coverage, submission digests, aggregate and declared tolerances', async t => {
  const f = await fixture(t)
  await f.freeze()
  const official = C.readJson(f.state().baselines[0].scoresFile)
  const clone = () => structuredClone(official)
  let other = clone(); other.cases[0].submissionDigest = C.hash('wrong'); assert.equal(compareScores(official, other, f.plan).status, 'fail')
  other = clone(); other.cases.pop(); assert.equal(compareScores(official, other, f.plan).status, 'fail')
  other = clone(); other.cases[0].status = 'infrastructure_error'; assert.throws(() => compareScores(official, other, f.plan), /基础设施/)
  other = clone(); other.aggregate.mean += 0.01; assert.equal(compareScores(official, other, f.plan).status, 'fail')
  assert.equal(compareScores(official, other, { ...f.plan, tolerances: { mean: 0.02 } }).status, 'pass')
  assert.throws(() => compareScores(official, official, { ...f.plan, tolerances: { typo: 1 } }), /容差/)
  other = clone(); other.cases[0].metrics.score = true; assert.equal(compareScores(official, other, f.plan).status, 'fail')
})

test('command runner enforces timeout and preserves nonzero and missing executable failures', async t => {
  const f = await fixture(t)
  const context = name => ({ repo: f.repo, run: f.directory, skill: C.skillRoot, attempt: path.join(f.root, name) })
  let result = await runCommand({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: '{repo}', timeoutSeconds: 1 }, context('timeout'))
  assert.equal(result.status, 'fail'); assert.match(result.reason, /超时/)
  result = await runCommand({ argv: [process.execPath, '-e', 'process.exit(7)'], cwd: '{repo}', timeoutSeconds: 1 }, context('nonzero'), Date.now() + 5000)
  assert.equal(result.exitCode, 7); assert.equal(result.status, 'fail')
  result = await runCommand({ argv: [path.join(f.root, 'does-not-exist')], cwd: '{repo}', timeoutSeconds: 1 }, context('missing'), Date.now() + 5000)
  assert.match(result.reason, /ENOENT/)
})

test('verbose commands are not killed for log volume and raw artifacts remain complete', async t => {
  const f = await fixture(t), attempt = path.join(f.root, 'verbose')
  const result = await runCommand({ argv: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(9*1024*1024));process.stdout.write(Buffer.alloc(9*1024*1024))", '{attempt}/official.bin'], cwd: '{repo}', timeoutSeconds: 10 }, { repo: f.repo, attempt })
  assert.equal(result.status, 'pass'); assert.equal(result.exitCode, 0); assert.equal(result.logTruncated, true)
  assert.equal(fs.statSync(path.join(attempt, 'stdout.log')).size, 8 * 1024 * 1024)
  assert.equal(fs.statSync(path.join(attempt, 'official.bin')).size, 9 * 1024 * 1024)
  const failed = await runCommand({ argv: [process.execPath, '-e', "process.stdout.write('verbose',()=>{process.exitCode=7})"], cwd: '{repo}', timeoutSeconds: 5, maxLogBytes: 1 }, { repo: f.repo, attempt: path.join(f.root, 'verbose-failure') })
  assert.equal(failed.status, 'fail'); assert.equal(failed.exitCode, 7); assert.equal(failed.logTruncated, true)
})

test('termination grace allows bounded cleanup but does not turn a timeout into success', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), attempt = path.join(f.root, 'grace')
  const result = await runCommand({ argv: [process.execPath, '-e', "process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(process.argv[1],'cleaned');process.exit(0)},800));setInterval(()=>{},100)", '{attempt}/cleanup.txt'], cwd: '{repo}', timeoutSeconds: 1, terminationGraceSeconds: 2 }, { repo: f.repo, attempt })
  assert.equal(fs.readFileSync(path.join(attempt, 'cleanup.txt'), 'utf8'), 'cleaned')
  assert.equal(result.status, 'fail'); assert.match(result.reason, /超时/)
})

test('shared evidence validation checks saved results without launching scorer or model commands', async t => {
  const f = await fixture(t)
  const attempt = path.join(f.root, 'saved-runtime')
  const output = path.join(attempt, 'result.json')
  await runCommand({ argv: [process.execPath, '{repo}/check.cjs', '{output}', 'runtime'], cwd: '{repo}', timeoutSeconds: 5 }, { repo: f.repo, attempt })
  write(path.join(f.repo, 'check.cjs'), "throw new Error('must not launch scorer')")
  assert.equal(f.state().attempts.length, 0)
  const original = C.readJson(output)
  const inspect = body => inspectCheck(body, { category: 'runtime' }, { attempt, output }, f.plan)
  assert.equal(inspect(original).status, 'pass')
  let body = structuredClone(original); body.facts.cases[0].correct = false; body.facts.cases[0].score = 0; assert.equal(inspect(body).status, 'pass')
  body = structuredClone(original); body.status = 'passed'; assert.throws(() => inspect(body), /允许范围/)
  body = structuredClone(original); delete body.facts.steps.cleanup; assert.throws(() => inspect(body), /cleanup/)
  body = structuredClone(original); body.facts.steps.cleanup.evidence = ['absent.json']; assert.throws(() => inspect(body), /证据文件/)
  body = structuredClone(original); delete body.evidenceDigests; assert.throws(() => inspect(body), /缺少摘要/)
  body = structuredClone(original); body.facts.cases[0].evaluatedRunId = 'other-run'; assert.throws(() => inspect(body), /关联不匹配/)
  body = structuredClone(original); body.facts.cases[0].evaluatedSubmissionDigest = C.hash('other submission'); assert.throws(() => inspect(body), /摘要不匹配/)
  body = structuredClone(original); body.facts.cases[0].caseId = 'other-case'; assert.throws(() => inspect(body), /逐 Case/)
  fs.appendFileSync(path.join(attempt, 'submission.txt'), 'tampered')
  assert.throws(() => inspect(C.readJson(output)), /摘要不匹配/)
  fs.unlinkSync(path.join(attempt, 'raw-query.json'))
  assert.throws(() => inspect(C.readJson(output)), /ENOENT/)
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
    await assert.rejects(f.report(), /锁/)
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
  assert.equal(invoke(['freeze', '--run', run, '--plan', f.planPath]).status, 'pass')
  assert.equal(invoke(['verify', '--run', run]).status, 'accepted')
  args[args.indexOf('--run-root') + 1] = path.join(copied, 'outputs')
  const refused = spawnSync(process.execPath, args, { cwd: os.tmpdir(), encoding: 'utf8' })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /Skill 包外/)
  assert.equal(C.treeHash(copied), before)
  fs.chmodSync(path.join(copied, 'SKILL.md'), 0o644)
  fs.appendFileSync(path.join(copied, 'SKILL.md'), '\nDocumentation-only correction.\n')
  assert.equal(invoke(['report', '--run', run]).status, 'accepted')
  fs.chmodSync(path.join(copied, 'scripts/checks.cjs'), 0o644)
  fs.appendFileSync(path.join(copied, 'scripts/checks.cjs'), '\n')
  const changedVerifier = spawnSync(process.execPath, [path.join(copied, 'scripts/onboard.cjs'), 'report', '--run', run], { encoding: 'utf8' })
  assert.equal(changedVerifier.status, 2)
  assert.match(JSON.parse(changedVerifier.stdout).limitations.join(' '), /验收程序已变化/)
  assert.equal(invoke(['freeze', '--run', run, '--plan', f.planPath]).reused, true)
  assert.equal(fs.readFileSync(path.join(f.root, 'official-calls'), 'utf8'), 'official\n')
  } finally { for (const dir of dirs) fs.chmodSync(dir, 0o755) }
})

test('packaged files and templates are complete without unfinished executable success stubs', () => {
  const root = C.skillRoot
  const text = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')
  for (const [, relative] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.join(root, relative.split('#')[0])), relative)
  const plan = C.readJson(path.join(root, 'assets/templates/acceptance-plan.json'))
  assert.doesNotThrow(() => ensurePlan(plan))
  assert.ok(plan.baseline.argv.length === 0 && !plan.candidate)
  assert.match(fs.readFileSync(path.join(root, 'assets/templates/adapter.ts.tmpl'), 'utf8'), /ONBOARDING_IMPLEMENTATION_REQUIRED/)
  const navigation = C.readJson(path.join(root, 'references/benchmark-protocol.sources.json'))
  assert.ok(navigation.files.length > 0)
  assert.equal(new Set(navigation.files.map(file => file.path)).size, navigation.files.length)
  for (const file of navigation.files) {
    assert.ok(file.path && file.role)
    assert.ok(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'), file.path)
  }
})

test('artifact evidence gate rejects omissions, renaming, wrong provenance, identity drift and summary substitution without external calls', async t => {
  const f = await fixture(t)
  const attempt = path.join(f.root, 'artifact-gate'), output = path.join(attempt, 'result.json')
  await runCommand({ argv: [process.execPath, '{repo}/check.cjs', '{output}', 'runtime'], cwd: '{repo}', timeoutSeconds: 5 }, { repo: f.repo, attempt })
  const original = C.readJson(output)
  const inspect = value => inspectCheck(value, { category: 'runtime' }, { attempt, output }, f.plan)
  assert.equal(inspect(original).artifactComparison.checkedOutputs, 1)
  const changes = [
    value => { delete value.facts.artifactChecks },
    value => { value.facts.artifactChecks = [] },
    value => { value.facts.artifactChecks[0].attachments[0].name = 'renamed.json' },
    value => { value.facts.artifactChecks[0].attachments = [] },
    value => { value.facts.artifactChecks[0].attachments[0].source = 'platform' },
    value => { value.facts.artifactChecks[0].evaluationId = 'old-evaluation' },
    value => { value.facts.artifactChecks[0].submissionDigest = C.hash('other-submission') },
    value => { value.facts.artifactChecks[0].attachments[0].sizeBytes++ },
    value => { value.facts.artifactChecks[0].attachments[0].file = value.facts.artifactChecks[0].outputs[0].file },
    value => { value.facts.artifactChecks[0].sourceEvidence = 'missing-source.json' },
    value => { value.facts.artifactChecks[0].attachments.push({ ...value.facts.artifactChecks[0].attachments[0], name: 'unmatched-original.json', artifactId: 'extra-id' }) },
    value => { value.facts.artifactChecks[0].attachments.push({ ...value.facts.artifactChecks[0].attachments[0], name: 'extra-diagnostic.log', source: 'platform' }) },
    value => { value.facts.artifactPresentation = { status: 'pass' } },
  ]
  for (const change of changes) {
    const value = structuredClone(original); change(value)
    assert.throws(() => inspect(value))
  }
  const changed = structuredClone(original), download = changed.facts.artifactChecks[0].attachments[0]
  fs.writeFileSync(path.join(attempt, download.file), 'summary only')
  download.sha256 = changed.evidenceDigests[download.file] = C.fileHash(path.join(attempt, download.file))
  download.sizeBytes = Buffer.byteLength('summary only')
  assert.throws(() => inspect(changed), /原始内容被替换/)
  const source = path.join(attempt, original.facts.artifactChecks[0].outputs[0].file)
  fs.unlinkSync(path.join(attempt, download.file)); fs.linkSync(source, path.join(attempt, download.file))
  assert.throws(() => inspect(original), /同一个文件/)
  assert.equal(fs.existsSync(path.join(f.root, 'service-calls')), false)
  assert.equal(fs.existsSync(path.join(f.root, 'official-calls')), false)
})

test('artifact checks preserve nested names and scalar returns while excluding runtime and platform extras from coverage', async t => {
  const f = await fixture(t)
  const attempt = path.join(f.root, 'artifact-forms'), output = path.join(attempt, 'result.json')
  await runCommand({ argv: [process.execPath, '{repo}/check.cjs', '{output}', 'runtime'], cwd: '{repo}', timeoutSeconds: 5 }, { repo: f.repo, attempt })
  const value = C.readJson(output)
  const inspect = body => inspectCheck(body, { category: 'runtime' }, { attempt, output }, f.plan)
  const record = value.facts.artifactChecks[0]
  record.outputs[0].name = record.attachments[0].name = '官方目录/实际 输出.json'
  record.attachments.push({ ...record.attachments[0], name: '平台诊断.log', source: 'platform', artifactId: 'platform-diagnostic' })
  record.attachments.push({ ...record.attachments[0], name: '接入层元数据.json', source: 'runtime-output', artifactId: 'adapter-metadata' })
  for (const extra of record.attachments.slice(1)) {
    const file = `${extra.artifactId}.json`
    fs.copyFileSync(path.join(attempt, extra.file), path.join(attempt, file))
    extra.file = file
    value.evidence.push(file)
    value.evidenceDigests[file] = extra.sha256
  }
  assert.equal(inspect(value).artifactComparison.checkedOutputs, 1)
  record.outputMode = 'return'
  assert.throws(() => inspect(value), /冒充官方/)
  record.outputs[0].source = record.attachments[0].source = 'official-return'
  assert.equal(inspect(value).status, 'pass')
  for (const returned of [true, false, 0, 'actual return']) {
    const bytes = JSON.stringify(returned)
    for (const item of [record.outputs[0], record.attachments[0]]) {
      fs.writeFileSync(path.join(attempt, item.file), bytes)
      value.evidenceDigests[item.file] = C.fileHash(path.join(attempt, item.file))
    }
    record.attachments[0].sha256 = value.evidenceDigests[record.attachments[0].file]
    record.attachments[0].sizeBytes = Buffer.byteLength(bytes)
    assert.equal(inspect(value).artifactComparison.checkedOutputs, 1)
  }
  record.outputMode = 'none'; record.outputs = []; record.attachments.shift()
  assert.throws(() => inspect(value), /无原生输出/)
  record.absenceReason = 'Synthetic rejection before invoking Harness; raw record and mapping referenced above'
  assert.equal(inspect(value).artifactComparison.checkedOutputs, 0)
  value.facts.artifactPresentation = { status: 'pass', evidence: 'raw-query.json' }
  assert.equal(inspect(value).artifactComparison.presentation, 'pass')
})

test('artifact originals reject adapter output and mismatched official source modes even when downloaded bytes match', async t => {
  const f = await fixture(t)
  const attempt = path.join(f.root, 'artifact-provenance'), output = path.join(attempt, 'result.json')
  await runCommand({ argv: [process.execPath, '{repo}/check.cjs', '{output}', 'runtime'], cwd: '{repo}', timeoutSeconds: 5 }, { repo: f.repo, attempt })
  const original = C.readJson(output)
  for (const [mode, source] of [
    ['files', 'runtime-output'], ['files', 'platform'], ['files', 'official-return'],
    ['return', 'runtime-output'], ['return', 'platform'], ['return', 'official-file'],
  ]) {
    const value = structuredClone(original), record = value.facts.artifactChecks[0]
    record.outputMode = mode
    record.outputs[0].source = record.attachments[0].source = source
    assert.throws(() => inspectCheck(value, { category: 'runtime' }, { attempt, output }, f.plan), /冒充官方|outputs\[0\].source: 不在允许范围/, `${mode}: ${source}`)
    assert.throws(() => require('../scripts/artifact-evidence.cjs').inspectArtifacts(value, [record], { attempt }), /冒充官方/, `${mode}: ${source}`)
  }
})

test('incomplete runtime evidence cannot pass and no scorer or Agent is relaunched for artifact validation', async t => {
  const f = await fixture(t)
  fs.appendFileSync(path.join(f.repo, 'check.cjs'), `
if(category==='runtime') { const value=JSON.parse(fs.readFileSync(output)); delete value.facts.artifactChecks; fs.writeFileSync(output,JSON.stringify(value)); }
`)
  await f.freeze()
  const body = C.readJson((await f.verify()).report)
  assert.equal(body.checks.find(item => item.id === 'runtime').status, 'fail')
  assert.match(body.checks.find(item => item.id === 'runtime').reason, /产物核对记录缺失/)
  assert.equal(fs.readFileSync(path.join(f.root, 'official-calls'), 'utf8'), 'official\n')
  assert.equal(fs.readFileSync(path.join(f.root, 'service-calls'), 'utf8'), 'service\n')
  assert.notEqual(body.status, 'accepted')
})
