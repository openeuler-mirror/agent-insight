import {loadExecutionConfig,executionSnapshot,readModelKey,stateRootFor,runDirectory,caseMode} from './shared/config.mjs';
import {sourceHashes} from './shared/source-hashes.mjs';
import { laneConfig, newTraceRows, acquireLane } from './shared/lane.mjs';
import { DatabaseSync } from 'node:sqlite';
import { cases, caseDirectory } from './shared/catalog.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { scenario001 } from './cases/001-setup/scenario.mjs';
import { scenario002 } from './cases/002-opencode-observation/scenario.mjs';
import { scenario003 } from './cases/003-skill-lifecycle/scenario.mjs';
import { scenario004 } from './cases/004-trace-evaluation/scenario.mjs';
import { scenario005 } from './cases/005-fault-recovery/scenario.mjs';
import { assertRunRoot, redact, renderReport, scenarioResult, requiredStagesFor, stageFailureStatus } from './shared/core.mjs';
import { prepareClients, prepareFixtures } from './shared/clients.mjs';
import { choosePort, startApplication, stopProcesses } from './shared/application.mjs';
import { command, stopCommands } from './shared/runtime.mjs';
import {startCoreModelMock} from './shared/model-mock.mjs';
import { startModelMock } from './cases/002-opencode-observation/model-mock.mjs';

process.umask(0o077);

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { config:{type:'string'},lane:{type:'string'},case: { type: 'string', default: '001' }, mode: {type:'string'}, 'key-file': { type: 'string' }, 'run-id': { type: 'string' } } });
caseDirectory(values.case);
const profile=values.lane||process.env.E2E_LANE||'pr';
const config=loadExecutionConfig({file:values.config,profile,overrides:values.mode?{mode:values.mode}:{}});values.mode=caseMode(config,values.case);
process.env.E2E_EXECUTION_CONFIG=JSON.stringify(config);process.env.E2E_LANE=profile;
const runId = values['run-id'] || new Date().toISOString().replace(/[-:.]/g, '').toLowerCase();
if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('Invalid run ID');
const root = runDirectory(project,config,runId);
assertRunRoot(project, root);
if (fs.existsSync(root)) throw new Error('Run ID already exists; use a fresh ID to retain the original attempt and evidence');
fs.mkdirSync(path.join(root, 'private'), { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const matches = [values.mode==='mock'?'e2e-local-synthetic-credential':readModelKey(values['key-file']?{file:path.resolve(values['key-file'])}:config.model.key)];
const secrets = [...matches];
const report = { runId, selectedCase: values.case, mode: values.mode, startedAt: new Date().toISOString(), testedSha: '', scenarios: cases.map(({id,title}) => ({ id: `CORE-E2E-${id}`, title, status: 'NOT_RUN', stages: [] })) };
report.configuration=executionSnapshot(config);
report.requiredStages=requiredStagesFor(values.case);
if(values.case==='004')report.testPlanVersion='trace-skill-complete-v2';
if(values.case==='005')report.testPlanVersion='real-ras-native-recovery-v1';
report.testedSha = (await command('git', ['rev-parse', 'HEAD'], { cwd: project })).output.trim();
report.testCodeHash = (await command('git', ['hash-object', `test/e2e/cases/${caseDirectory(values.case)}/scenario.mjs`], { cwd: project })).output.trim();
report.testBundleHashes = Object.fromEntries(fs.readdirSync(path.join(project, 'test/e2e'), { recursive: true }).filter(file => !file.split(path.sep).includes('node_modules') && (file.endsWith('.mjs') || file === 'package-lock.json')).sort().map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(project, 'test/e2e', file))).digest('hex')]));
report.startupScriptHash = createHash('sha256').update(fs.readFileSync(path.join(project, 'scripts/develop_start.sh'))).digest('hex');
report.nodeVersion = process.version;
report.fixtureHashes = Object.fromEntries(fs.readdirSync(path.join(project, 'test/e2e/cases'), { recursive: true }).filter(file => file.includes('fixtures'+path.sep) && fs.statSync(path.join(project, 'test/e2e/cases', file)).isFile()).sort().map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(project, 'test/e2e/cases', file))).digest('hex')]));
report.productSourceHashes = sourceHashes(project, ['src/lib/skill-generator-opencode-bridge.ts', 'src/lib/skill-opt-bridge.ts', 'src/lib/engine/skill-generation/opencode-agent-cli/opencode-client.ts', 'src/lib/engine/skill-generation/opencode-agent-cli/completed-reply.ts', 'src/components/skill-workbench/SkillWorkbenchShell.tsx', 'src/lib/skill-workbench/generated-session-sync.ts', 'src/app/api/observe/executions/[executionId]/agent-debug/route.ts', 'src/app/api/observe/executions/[executionId]/agent-debug/skills-analysis/route.ts', 'scripts/skill-experiment-workspace.cjs', 'src/lib/engine/evaluation/opencode-trajectory-evaluator.ts', 'src/lib/system-agent-names.ts']);
if(values.case==='005'){
 const files=['scripts/install-ras.js','scripts/install-ras-client.js','scripts/reliability-client.cjs','src/components/eval/ExperimentWizard.tsx','src/lib/engine/experiment/ras-reliability-evaluator.ts','src/lib/reliability/client-config-service.ts','src/server/builtin-example/ensure-reliability-dataset.ts','agent_fault_injection/platform_adapters/opencode/adapter.py','agent_fault_injection/pipeline/runner.py','agent_fault_injection/platform_adapters/opencode/catalog.py','agent_fault_injection/fault_inject/skills/thinking-dead-loop/SKILL.md','agent_ras/platform_adapter/opencode/plugin.js','agent_ras/platform_adapter/opencode/host_control.js','agent_ras/config/agent_ras_config.default.yaml'];
 for(const file of files)report.productSourceHashes[file]=createHash('sha256').update(fs.readFileSync(path.join(project,file))).digest('hex');
}
const current = report.scenarios[Number(values.case) - 1];
const persist = () => {
  const safe = JSON.parse(redact(JSON.stringify(report), secrets));
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(safe, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'report.html'), renderReport(safe));
};
const stage = async (id, expected, fn) => {
  const row = { id, expected, status: 'RUNNING', startedAt: new Date().toISOString() };current.stages.push(row);persist();
  console.log(`${id}: RUNNING`);
  const warning = setInterval(() => console.log(`${id}: waiting for real dependency (${Math.round((Date.now() - Date.parse(row.startedAt)) / 1000)}s)`), 45000);
  try { row.actual = await fn();row.status = 'PASS';if(lane&&['login','fixture'].includes(id))report.seededTraceIds=newTraceRows(traceRows(),previousTraceIds).map(t=>t.taskId); }
  catch (error) { row.status = stageFailureStatus(error);row.actual = redact(error.message, secrets);throw error; }
  finally { clearInterval(warning);row.endedAt = new Date().toISOString();Object.assign(current, scenarioResult(current.stages, values.case));persist();console.log(`${id}: ${row.status}`); }
};
const port = await choosePort();
report.baseUrl = `http://127.0.0.1:${port}`;
const lane=stateRootFor(config)?laneConfig(profile,stateRootFor(config),config):null;
const standaloneLease=lane&&!process.env.E2E_SUITE_OWNS_LANE?acquireLane(lane,runId):null;
if(lane){report.lane=lane.lane;report.account=lane.username;fs.mkdirSync(lane.appHome,{recursive:true,mode:0o700});}
const ctx = { executionConfig:config,testUsername:config.account.username,...(lane?{testUsername:lane.username,persistentAppHome:lane.appHome}:{}), modelBaseUrl:process.env.E2E_MODEL_BASE_URL, project, root, runId, key: matches[0], secrets, stage, baseUrl: report.baseUrl,
  prepareClients, prepareFixtures, selectedCase: values.case, mode:values.mode };
if(values.mode==='mock'){
  const data=fs.readFileSync(path.join(project,'public/example/messages'),'utf8');
  ctx.modelMock=values.case!=='002'?await startCoreModelMock(ctx):await startModelMock({file:path.join(root,'ordinary/workspace/fixtures/messages'),firstLine:data.split('\n')[0],lineCount:data.trimEnd().split('\n').length});
  ctx.modelBaseUrl=ctx.modelMock.baseUrl;
}
const traceRows=()=>{const file=path.join(lane?.appHome||path.join(root,'app'),'data/witty_insight.db');if(!lane||!fs.existsSync(file))return [];const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT taskId,agentName,query FROM Execution WHERE user=? ORDER BY taskId').all(lane.username);}catch{return [];}finally{db.close();}};
const previousTraceIds=traceRows().map(row=>row.taskId);
let shuttingDown = false;
const interrupted = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  report.interrupted = true;
  report.error = 'Execution interrupted; incomplete stages are not passed';
  try { await stopCommands(); await ctx.modelMock?.close(); await stopProcesses(ctx); }
  catch { report.cleanupError = 'Interrupted cleanup failed; inspect owned processes'; }
  report.endedAt = new Date().toISOString();Object.assign(current, scenarioResult(current.stages, values.case));persist();standaloneLease?.release();process.exit(143);
};
const caseDeadline=setTimeout(interrupted,config.timeouts.caseMs);caseDeadline.unref();
process.on('SIGTERM', interrupted);process.on('SIGINT', interrupted);
try {
  await stage('application', '安全启动隔离应用与当前 schema 数据库，不占用已有端口', async () => {
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/caffeinate')) {
      const guard = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { guard.once('spawn', resolve);guard.once('error', reject); });
      ctx.children = [guard];
      report.executionGuard = { kind: 'process-scoped caffeinate', persistentSettingsChanged: false };
    }
    const binary = path.join(project, 'exclude/core-e2e/runtime/v2/node_modules/.bin/opencode');
    if (!fs.existsSync(binary)) {
      const installed = await command('npm', ['install', '--prefix', path.join(project, 'exclude/core-e2e/runtime/v2'), '@opencode/cli@2.1.4', '--no-audit', '--no-fund'], { cwd: project, log: path.join(root, 'private/install-v2.log'), timeout: 180000 });
      if (installed.code !== 0) throw new Error('Required OpenCode v2 installation failed');
    }
    return startApplication(ctx);
  });
  await ({ '001': scenario001, '002': scenario002, '003': scenario003, '004': scenario004, '005': scenario005 }[values.case])(ctx);
  if(ctx.modelMock)await stage('model-protocol','本轮全部模型请求由本地协议夹具处理，无未知请求或真实模型回退',async()=>{if(ctx.modelMock.evidence.errors.length)throw Error('Model mock protocol errors: '+ctx.modelMock.evidence.errors.join('; '));return {requests:ctx.modelMock.evidence.requests,externalModelRequests:0,errors:[]};});
} catch (error) {
  report.error = redact(error.message, secrets);
  console.log(values.case + ':', redact(error.message, secrets));
  process.exitCode = 1;
} finally {
  if (shuttingDown) await new Promise(() => {});
  clearTimeout(caseDeadline);
  if(fs.existsSync(path.join(project,'server.log')))fs.copyFileSync(path.join(project,'server.log'),path.join(root,'private/application.log'));
  if(ctx.modelMock){report.modelMock=ctx.modelMock.evidence;await ctx.modelMock.close();}
  try { await stage('cleanup', '本轮前台客户端进程全部停止，其他用户的后台服务不受影响', async () => stopProcesses(ctx)); }
  catch (error) { report.cleanupError = redact(error.message, secrets);process.exitCode = 1; }
  if(lane){report.traces=newTraceRows(traceRows(),previousTraceIds).filter(t=>!(report.seededTraceIds||[]).includes(t.taskId)).map(({taskId,agentName})=>({taskId,agentName}));fs.mkdirSync(path.join(lane.home,'runs'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(lane.home,'runs',runId+'.json'),JSON.stringify({runId,caseId:values.case,account:lane.username,testedSha:report.testedSha,traces:report.traces,status:current.status},null,2),{flag:'wx',mode:0o600});}
  report.endedAt = new Date().toISOString();Object.assign(current, scenarioResult(current.stages, values.case));persist();
  const rendered = await command(process.execPath, [path.join(project, 'test/e2e/report.mjs'), '--run-dir', root], { cwd: project });
  if (rendered.code !== 0) process.exitCode = 1;
  console.log('Report:', path.join(root, 'report.html'));
  standaloneLease?.release();
  process.removeListener('SIGTERM', interrupted);process.removeListener('SIGINT', interrupted);
}
