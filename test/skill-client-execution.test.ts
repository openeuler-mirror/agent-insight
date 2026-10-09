import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { selectSkillExecutionTarget } from '@/lib/skill-workbench/execution-target';
import { executionModelMismatch } from '@/lib/skill-workbench/execution-model';
import { withSkillClientSlot } from '@/lib/skill-workbench/client-execution-slot';
import { assertSkillExecutionOutput, assertTriggerExecutionEvidence, isTraceGenerationFailureRetryable } from '@/lib/engine/experiment/trace-generation';
import { classifyTriggerExecution, shouldStopTriggerBatch } from '@/lib/skill-workbench/trigger-execution';
import { parseCapabilities } from '@/lib/reliability/client-registry';

const require = createRequire(import.meta.url);
const workspace = require('../scripts/skill-experiment-workspace.cjs');
const client = require('../scripts/reliability-client.cjs');
const target = {
  workerId: 'selected-client', host: 'test-host', hostname: 'test-host', platform: 'opencode',
  agent: 'build', agentLabel: 'build', models: [{ id: 'csi-provider/GLM-5.2', label: 'GLM' }],
  lastSeenAt: new Date().toISOString(), supportsSkillSnapshot: true,
};
const selection = { ...target, model: 'csi-provider/GLM-5.2' };
const skill = { name: 'test-skill', version: 2, files: { 'SKILL.md': '---\nname: test-skill\ndescription: test\n---\nversion two', 'references/test.txt': 'version two reference' } };

test('冻结真实主机/Agent/模型，缺失、离线、旧客户端与不存在模型一律拒绝', () => {
  assert.equal(selectSkillExecutionTarget(selection, [target]).model, 'csi-provider/GLM-5.2');
  assert.equal(selectSkillExecutionTarget({ ...selection, host: 'forged' }, [target]).host, target.host);
  for (const [input, targets, code] of [
    [null, [target], 'execution_target_required'],
    [selection, [], 'execution_target_unavailable'],
    [selection, [{ ...target, supportsSkillSnapshot: false }], 'skill_execution_unsupported'],
    [{ ...selection, model: 'missing' }, [target], 'MODEL_UNAVAILABLE'],
  ] as const) {
    assert.throws(() => selectSkillExecutionTarget(input, [...targets]), (err: unknown) => (err as { code: string }).code === code);
  }
  const capabilities = parseCapabilities(JSON.stringify({ platforms: [{ id: 'opencode', runExperimentCase: { version: 2, returnsTraceId: true, skillSnapshotVersion: 1 } }] }));
  assert.equal(capabilities.platforms[0].runExperimentCase?.skillSnapshotVersion, 1);
});

test('无输出、模型未知或模型不一致不进入评分，且不自动换模型重试', () => {
  assert.doesNotThrow(() => assertSkillExecutionOutput({ model: 'GLM-5.2', finalResult: '真实回答' }, selection.model));
  for (const [record, code] of [
    [{ model: 'GLM-5.2', finalResult: '' }, 'AGENT_NO_OUTPUT'],
    [{ model: null, finalResult: 'output' }, 'MODEL_UNCONFIRMED'],
    [{ model: 'deepseek-v4-flash', finalResult: 'output' }, 'MODEL_MISMATCH'],
  ] as const) {
    assert.throws(() => assertSkillExecutionOutput(record, selection.model), (err: unknown) => (err as { code: string }).code === code);
    assert.equal(isTraceGenerationFailureRetryable(code), false);
  }
  assert.equal(executionModelMismatch(selection.model, ['deepseek-v4-flash']), true);
  assert.equal(executionModelMismatch(selection.model, ['GLM-5.2', selection.model]), false);
});

test('触发分析必须确认客户端、模型调用及真实 Skill 调用，运行错误不能当作未触发', () => {
  const triggerTarget = { ...target, supportsTriggerRouting: true };
  assert.equal(selectSkillExecutionTarget(selection, [triggerTarget], true).workerId, target.workerId);
  assert.throws(() => selectSkillExecutionTarget(selection, [target], true), (err: unknown) => (err as { code: string }).code === 'trigger_execution_unsupported');
  assert.doesNotThrow(() => assertTriggerExecutionEvidence({ clientId: target.workerId, llmCallCount: 1 }, target.workerId));
  for (const [record, code] of [
    [{ clientId: 'wrong-client', llmCallCount: 1 }, 'CLIENT_MISMATCH'],
    [{ clientId: target.workerId, llmCallCount: 0 }, 'MODEL_NO_RESPONSE'],
  ] as const) {
    assert.throws(() => assertTriggerExecutionEvidence(record, target.workerId), (err: unknown) => (err as { code: string }).code === code);
    assert.equal(isTraceGenerationFailureRetryable(code), false);
  }
  assert.deepEqual(classifyTriggerExecution({ invokedSkills: '[]' }, skill.name), { triggered: false, competingSkill: null });
  assert.deepEqual(classifyTriggerExecution({ invokedSkills: JSON.stringify([{ name: skill.name, version: 2 }]) }, skill.name), { triggered: true, competingSkill: null });
  assert.deepEqual(classifyTriggerExecution({ invokedSkills: JSON.stringify([{ name: 'other-skill' }]) }, skill.name), { triggered: false, competingSkill: 'other-skill' });
  assert.throws(() => classifyTriggerExecution({}, skill.name), /未记录 Skill 调用信息/);
});

test('Skill 两侧快照和无 Skill 对照组使用独立目录；文件路径不能越界', () => {
  const make = (snapshot: typeof skill | null) => workspace.prepareSkillExperimentWorkspace('unused', {
    platform: 'opencode', agent: 'build', model: selection.model, skillExecution: { version: 1, skill: snapshot },
  }, { provider: {}, model: 'deepseek/default' });
  const a = make(skill);
  const b = make({ ...skill, version: 3, files: { ...skill.files, 'SKILL.md': 'version three' } });
  const baseline = make(null);
  try {
    assert.notEqual(a.cwd, b.cwd);
    assert.match(fs.readFileSync(path.join(a.cwd, '.opencode/skills/test-skill/SKILL.md'), 'utf8'), /version two/);
    assert.equal(fs.readFileSync(path.join(b.cwd, '.opencode/skills/test-skill/SKILL.md'), 'utf8'), 'version three');
    assert.equal(fs.existsSync(path.join(baseline.cwd, '.opencode/skills')), false);
    const config = JSON.parse(a.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, selection.model);
    assert.equal(config.permission.skill['*'], 'deny');
    assert.equal(config.permission.skill['test-skill'], 'allow');
    assert.equal(JSON.parse(baseline.env.OPENCODE_CONFIG_CONTENT).permission.skill['*'], 'deny');
    assert.notEqual(a.env.HOME, os.homedir());
    assert.equal(fs.readdirSync(a.env.HOME).length, 0);
  } finally { a.cleanup(); b.cleanup(); baseline.cleanup(); }
  assert.equal(fs.existsSync(a.cwd), false);
  for (const file of ['../escape', '/absolute', 'C:/windows', 'refs/../../escape', 'refs\\escape']) {
    assert.throws(() => workspace.validateSkillSnapshot({ ...skill, files: { ...skill.files, [file]: 'bad' } }), /不安全/);
  }
});

test('触发分析客户端工作区只读、允许 Skill 自主路由，且不强制加载被测 Skill', () => {
  const isolated = workspace.prepareSkillExperimentWorkspace('unused', {
    platform: 'opencode', agent: 'build', model: selection.model,
    skillExecution: { version: 2, mode: 'trigger', targetSkillName: skill.name, skills: [skill, { ...skill, name: 'other-skill' }] },
  }, { provider: {}, model: 'wrong/default', mcp: { unsafe: {} } });
  try {
    const config = JSON.parse(isolated.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.model, selection.model);
    assert.equal(config.permission.skill, 'allow');
    assert.equal(config.permission.bash, 'deny');
    assert.equal(config.permission.write, 'deny');
    assert.deepEqual(config.mcp, {});
    assert.doesNotMatch(config.agent.build.prompt, /先加载该 Skill/);
    assert.equal(fs.existsSync(path.join(isolated.cwd, '.opencode/skills/test-skill/SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(isolated.cwd, '.opencode/skills/other-skill/SKILL.md')), true);
  } finally { isolated.cleanup(); }
});

test('单个输入、Trace 或瞬时连接错误不跳过后续触发 Case', () => {
  for (const code of ['MODEL_ERROR', 'MODEL_NO_RESPONSE', 'MODEL_START_TIMEOUT', 'AGENT_NO_OUTPUT', 'EVENT_MONITOR_UNAVAILABLE', 'TRACE_INGEST_TIMEOUT']) {
    assert.equal(shouldStopTriggerBatch(code), false, code);
  }
  for (const code of ['MODEL_UNAVAILABLE', 'MODEL_MISMATCH', 'CLIENT_MISMATCH']) {
    assert.equal(shouldStopTriggerBatch(code), true, code);
  }
});

test('触发工作区复用冻结依赖，但并发租约、客户端、模型和实验之间隔离', () => {
  const payload = { platform: 'opencode', agent: 'build', model: selection.model,
    correlation: { experimentId: 'cache-test' },
    skillExecution: { version: 2, mode: 'trigger', targetSkillName: skill.name, skills: [skill] } };
  const make = (value = payload, clientId = 'test') => workspace.prepareSkillExperimentWorkspace('unused', value, { provider: {} }, clientId);
  const first = make();
  const busy = make();
  assert.notEqual(first.cwd, busy.cwd);
  busy.cleanup();
  const dependency = path.join(first.env.OPENCODE_CONFIG_DIR, 'dependency-sentinel');
  fs.writeFileSync(dependency, 'retained');
  first.cleanup();
  const warm = make();
  assert.equal(warm.reused, true);
  assert.equal(warm.cwd, first.cwd);
  assert.equal(fs.readFileSync(dependency, 'utf8'), 'retained');
  const otherClient = make(payload, 'other-client');
  assert.notEqual(otherClient.cwd, warm.cwd);
  otherClient.cleanup(true);
  warm.cleanup();
  const changedModel = make({ ...payload, model: 'other/model' });
  assert.notEqual(changedModel.cwd, first.cwd);
  assert.equal(fs.existsSync(first.cwd), false);
  changedModel.cleanup();
  const next = make({ ...payload, correlation: { experimentId: 'next-experiment' } });
  assert.notEqual(next.cwd, changedModel.cwd);
  next.cleanup();
  const revised = make({ ...payload, skillExecution: { ...payload.skillExecution, skills: [{ ...skill, version: 3 }] } });
  assert.notEqual(revised.cwd, first.cwd);
  revised.cleanup();
  workspace.clearTriggerWorkspaces();
  assert.equal(fs.existsSync(next.cwd), false);
  assert.equal(fs.existsSync(revised.cwd), false);
});

test('触发启动与路由分别计时，路径输入原样传递，超时后的迟到命中不能覆盖失败', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-timing-test-'));
  const priorPath = process.env.PATH;
  const report = path.join(root, 'report.json');
  fs.writeFileSync(path.join(root, 'opencode'), `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('debug')) { console.log('{"provider":{}}'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('opencode run --format json'); process.exit(0); }
const send = (kind, extra={}) => fs.writeSync(3, JSON.stringify({protocol:1,token:process.env.AGENT_INSIGHT_EVENT_TOKEN,kind,sessionId:'timing-session',...extra})+'\\n');
let input=''; process.stdin.on('data', chunk => input+=chunk); process.stdin.on('end', () => {
 fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({input,args:process.argv.slice(2)}));
 if(input==='no-start') { setInterval(()=>{},1000); return; }
 const start=()=>{
  send('ready'); send('session'); send('model',{model:'csi-provider/GLM-5.2'});
  if(input==='route-hang' || input==='late-hit') {
   if(input==='late-hit') process.on('SIGTERM',()=>{send('trigger',{skillName:'test-skill'});process.exit(0);});
   setInterval(()=>{},1000); return;
  }
  send('trigger',{skillName:'test-skill'}); setInterval(()=>{},1000);
 };
 if(input==='slow-start') setTimeout(start,1300); else start();
});
`, { mode: 0o700 });
  process.env.PATH = `${root}:${priorPath || ''}`;
  const payload = { platform: 'opencode', agent: 'build', model: selection.model, timeoutSeconds: 1, startupTimeoutSeconds: 3,
    correlation: { experimentId: 'timing' }, skillExecution: { version: 2, mode: 'trigger', targetSkillName: skill.name, skills: [skill] } };
  const run = (input: string, overrides = {}) => client.runExperimentCase({ clientId: 'test', workspaceBase: root }, { ...payload, input, ...overrides });
  try {
    const slow = await run('slow-start');
    assert.equal(slow.triggerDecision.triggered, true);
    assert.ok(slow.startupDurationMs >= 1200);
    assert.equal(slow.workspaceReused, false);
    const raw = '/Users/lin/Downloads/var-log-messages.gz 这是日志，请判断';
    const hit = await run(raw);
    assert.equal(hit.workspaceReused, true);
    const observed = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(observed.input, raw);
    assert.equal(observed.args.includes('--command'), false);
    await assert.rejects(run('no-start', { startupTimeoutSeconds: 1 }), { code: 'AGENT_STARTUP_TIMEOUT' });
    for (const input of ['route-hang', 'late-hit']) {
      await assert.rejects(run(input), { code: 'TRIGGER_ROUTING_TIMEOUT' });
    }
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 200);
    try { await assert.rejects(run('no-start', { signal: controller.signal }), { code: 'EXECUTION_CANCELLED' }); }
    finally { clearTimeout(cancellation); }
    const afterCancel = await run(raw);
    assert.equal(afterCancel.workspaceReused, false);
    for (const code of ['AGENT_STARTUP_TIMEOUT', 'TRIGGER_ROUTING_TIMEOUT']) assert.equal(isTraceGenerationFailureRetryable(code), false);
  } finally {
    workspace.clearTriggerWorkspaces();
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同一客户端串行执行，取消的排队任务不会启动，异常后释放执行槽', async () => {
  const controller = new AbortController();
  const cancelled = new AbortController();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withSkillClientSlot('worker', controller.signal, async () => { events.push('a-start'); await gate; events.push('a-end'); });
  const second = withSkillClientSlot('worker', controller.signal, async () => { events.push('b'); throw new Error('expected'); });
  const secondResult = assert.rejects(second, /expected/);
  const third = withSkillClientSlot('worker', cancelled.signal, async () => { events.push('must-not-start'); });
  const thirdResult = assert.rejects(third);
  cancelled.abort();
  await Promise.resolve();
  assert.deepEqual(events, ['a-start']);
  release();
  await Promise.all([first, secondResult, thirdResult]);
  await withSkillClientSlot('worker', controller.signal, async () => { events.push('next'); });
  assert.deepEqual(events, ['a-start', 'a-end', 'b', 'next']);
});

test('真实客户端启动参数使用所选模型；模型错误不会返回成功输出', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-client-test-'));
  const executable = path.join(root, 'opencode');
  const report = path.join(root, 'report.json');
  const priorPath = process.env.PATH;
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('debug')) { console.log(JSON.stringify({provider:{},model:'other/default'})); process.exit(0); }
if (process.argv.includes('--help')) { console.log('opencode run --format json'); process.exit(0); }
fs.writeSync(3, JSON.stringify({ protocol: 1, token: process.env.AGENT_INSIGHT_EVENT_TOKEN, kind: 'ready' }) + '\\n');
fs.writeSync(3, JSON.stringify({ protocol: 1, token: process.env.AGENT_INSIGHT_EVENT_TOKEN, kind: 'session', sessionId: 'test-trace' }) + '\\n');
fs.writeSync(3, JSON.stringify({ protocol: 1, token: process.env.AGENT_INSIGHT_EVENT_TOKEN, kind: 'model', sessionId: 'test-trace', model: 'csi-provider/GLM-5.2' }) + '\\n');
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),model:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).model}));
let query=''; process.stdin.on('data', data => query += data); process.stdin.on('end', () => {
 console.log(JSON.stringify({type:'step_start',sessionID:'test-trace',part:{type:'step-start'}}));
 if(query==='hit') {
  fs.writeSync(3, JSON.stringify({ protocol: 1, token: process.env.AGENT_INSIGHT_EVENT_TOKEN, kind: 'trigger', sessionId: 'test-trace', skillName: 'test-skill' }) + '\\n');
  setInterval(() => {}, 1000);
 }
 else if(query==='error') console.log(JSON.stringify({type:'session.error',sessionID:'test-trace',error:{name:'ProviderError',message:'connection closed'}}));
 else if(query==='empty') console.log(JSON.stringify({type:'session.idle',sessionID:'test-trace'}));
 else {
  console.log(JSON.stringify({type:'text',sessionID:'test-trace',part:{type:'text',text:'actual output'}}));
  if(query!=='no-finish') fs.writeSync(3, JSON.stringify({ protocol: 1, token: process.env.AGENT_INSIGHT_EVENT_TOKEN, kind: 'finished', sessionId: 'test-trace' }) + '\\n');
 }
});
`, { mode: 0o700 });
  process.env.PATH = `${root}:${priorPath || ''}`;
  const payload = { platform: 'opencode', agent: 'build', model: selection.model, input: 'success', timeoutSeconds: 5, skillExecution: { version: 1, skill } };
  try {
    const result = await client.runExperimentCase({ clientId: 'test', workspaceBase: root }, payload);
    assert.equal(result.traceId, 'test-trace');
    const observed = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(observed.args[observed.args.indexOf('--model') + 1], selection.model);
    assert.equal(observed.model, selection.model);
    assert.notEqual(observed.cwd, root);
    assert.equal(fs.existsSync(observed.cwd), false);
    const triggerPayload = { ...payload, skillExecution: { version: 2, mode: 'trigger', targetSkillName: skill.name, skills: [skill] } };
    const triggerResult = await client.runExperimentCase({ clientId: 'test', workspaceBase: root }, triggerPayload);
    assert.equal(triggerResult.traceId, 'test-trace');
    assert.equal(triggerResult.triggerDecision.triggered, false);
    const hitStarted = Date.now();
    const hit = await client.runExperimentCase({ clientId: 'test', workspaceBase: root }, { ...triggerPayload, input: 'hit' });
    assert.equal(hit.triggerDecision.triggered, true);
    assert.equal(hit.triggerDecision.endReason, 'skill_loaded');
    assert.ok(Date.now() - hitStarted < 4_000);
    await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: root }, { ...triggerPayload, input: 'no-finish' }),
      { code: 'TRIGGER_EVIDENCE_MISSING' });
    const triggerObserved = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(triggerObserved.args[triggerObserved.args.indexOf('--model') + 1], selection.model);
    assert.equal(triggerObserved.model, selection.model);
    for (const input of ['error', 'empty']) {
      await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: root }, { ...payload, input }),
        (err: unknown) => ['MODEL_ERROR', 'MODEL_NO_RESPONSE'].includes((err as { code: string }).code));
      await assert.rejects(client.runExperimentCase({ clientId: 'test', workspaceBase: root }, { ...triggerPayload, input }),
        (err: unknown) => ['MODEL_ERROR', 'MODEL_NO_RESPONSE'].includes((err as { code: string }).code));
    }
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Skill 执行目标和快照贯穿向导、编排、下发与重新执行，不进入默认模型分支', () => {
  const wizard = fs.readFileSync('src/components/eval/ExperimentWizard.tsx', 'utf8');
  assert.match(wizard, /executionTarget: selectedTarget \? \{\s*workerId: selectedTarget.workerId/);
  const service = fs.readFileSync('src/lib/skill-workbench/experiment-service.ts', 'utf8');
  assert.match(service, /activeModel = executionTarget \? null/);
  assert.match(service, /skillSnapshots: executionTarget/);
  const route = fs.readFileSync('src/app/api/debug/grayscale-tasks/[taskId]/route.ts', 'utf8');
  assert.match(route, /executeSkillCaseOnClient\(\{/);
  assert.match(route, /skill: args.config.skillSnapshots\[target.side\]/);
  assert.ok(route.indexOf('const clientResult = await executeSkillCaseOnClient') < route.indexOf('const frozenModel = args.config.modelConfigId'));
  const generator = fs.readFileSync('src/lib/engine/experiment/trace-generation.ts', 'utf8');
  assert.match(generator, /skillExecution: input.req.skillExecution/);
  assert.match(generator, /assertSkillExecutionOutput\(execution, input.req.model\)/);
  assert.match(generator, /commandWaitMs = \(input.timeoutSeconds \+ startupSeconds \+ 90\)/);
  assert.match(generator, /startupTimeoutSeconds: startupSeconds/);
  assert.match(wizard, /路由会话就绪后计时/);
  const detail = fs.readFileSync('src/components/eval/ExperimentDetail.tsx', 'utf8');
  assert.match(detail, /已计分 \{row.scored\} \/ \{detail.caseTotal\} 项/);
});
