import {compileProduction} from './control/build-preflight.mjs';
import {loadExecutionConfig,executionSnapshot,readModelKey,stateRootFor,runDirectory,caseMode,suiteMode} from './shared/config.mjs';
import {selectedCases} from './shared/selection.mjs';
import {boundedUtEnv} from './shared/ut-environment.mjs';
import {cleanupContainerOrphans} from './shared/container-cleanup.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { laneConfig, acquireLane } from './shared/lane.mjs';
import { command, stopCommands } from './shared/runtime.mjs';
import { executeSuite, parseUtResult, renderSummary } from './shared/suite.mjs';
import { cases,caseDirectory } from './shared/catalog.mjs';
import { redact } from './shared/core.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {values}=parseArgs({options:{'check-config':{type:'boolean'},config:{type:'string'},'skip-ut':{type:'boolean'},all:{type:'boolean'},profile:{type:'string'},case:{type:'string'},mode:{type:'string'},ut:{type:'boolean'},prepare:{type:'boolean'},list:{type:'boolean'},help:{type:'boolean'},lane:{type:'string'},'state-dir':{type:'string'},'key-file':{type:'string'},'run-id':{type:'string'},'ut-timeout-ms':{type:'string'}}});
if(values.help){console.log('node test/e2e/run.mjs [--config file] [--profile pr|daily|core-five|--all|--case 002] [--mode mock|real] [--ut|--skip-ut] [--key-file /path/to/key] [--run-id id]\n--prepare 安装测试依赖及 Chromium；--list 查看场景。默认001 Real、002/003/004/005 Mock。生产编译失败即停止UT/E2E。显式--mode覆盖逐例模式，--all执行001–005。未完成项不能算通过。');process.exit(0);}
if(values.list){console.log(cases.map(c=>c.id+' '+c.title).join('\n'));process.exit(0);}
if(values.prepare){
  const install=await command('npm',['ci','--prefix','test/e2e','--no-audit','--no-fund'],{cwd:project,timeout:300000});
  if(install.code!==0)throw Error('Test dependency installation failed');
  const browser=await command(process.execPath,['node_modules/playwright/cli.js','install','chromium'],{cwd:path.join(project,'test/e2e'),timeout:300000});
  if(browser.code!==0)throw Error('Chromium installation failed');
  console.log('Test dependencies and Chromium installed');process.exit(0);
}
if([values.all,values.case,values.profile].filter(Boolean).length>1)throw Error('Choose at most one of --all, --case or --profile');
const executionProfile=['pr','daily'].includes(values.profile)?values.profile:values.lane||process.env.E2E_LANE||'pr';
const overrides={...(values.mode?{mode:values.mode}:{}),...(values.ut?{runUt:true}:{}),...(values['skip-ut']?{runUt:false}:{})};
if(values['key-file'])overrides.model={key:{file:path.resolve(values['key-file'])}};
if(values['ut-timeout-ms'])overrides.timeouts={utMs:Number(values['ut-timeout-ms'])};
const config=loadExecutionConfig({file:values.config,profile:executionProfile,overrides});values.mode=config.mode;
const selected=values.case?[values.case]:values.all?cases.map(c=>c.id):values.profile==='core-five'?selectedCases('core-five'):config.cases;
config.cases=selected;
const effectiveMode=suiteMode(config);
if(values.profile&&!['pr','daily','core-five'].includes(values.profile))throw Error('Unknown profile');
if(values.case)caseDirectory(values.case);
if(values['check-config']){console.log(JSON.stringify(executionSnapshot(config),null,2));process.exit(0);}
const timeout=config.timeouts.utMs;
const runId=values['run-id']||'suite-'+Date.now()+'-'+randomUUID().slice(0,8);
if(!/^[a-z0-9-]{1,100}$/.test(runId))throw Error('Invalid run ID');
const stateRoot=values['state-dir']||stateRootFor(config);
const lane=stateRoot?laneConfig(executionProfile,stateRoot,config):null;
if(values.lane&&!stateRoot)throw Error('A lane requires an isolated state directory');
if(values['state-dir']&&!lane)throw Error('--state-dir requires --lane pr|daily');
const root=runDirectory(project,config,runId);
const lease=lane?acquireLane(lane,runId):null;
let modelKeyFile,credentialWritten=false,totalDeadline,suiteStopping=false;
const cleanKey=()=>{if(credentialWritten&&fs.existsSync(modelKeyFile)){fs.unlinkSync(modelKeyFile);credentialWritten=false;}};
const stop=async()=>{if(suiteStopping)return;suiteStopping=true;await stopCommands({graceMs:config.timeouts.cleanupGraceMs});
 const file=path.join(root,'report.json');if(fs.existsSync(file)){const report=JSON.parse(fs.readFileSync(file));report.status='BLOCKED';report.interrupted=true;report.endedAt=new Date().toISOString();if(report.npmTest?.status==='RUNNING'){const log=path.join(root,'private/npm-test.log');report.npmTest=parseUtResult(fs.existsSync(log)?fs.readFileSync(log,'utf8'):'',{code:null,signal:'SIGTERM'});}for(const row of report.scenarios)if(row.status==='RUNNING'){row.status='BLOCKED';row.reason='执行被中断';}fs.writeFileSync(file,JSON.stringify(report,null,2));}
 cleanKey();lease?.release();process.exit(143);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try{
fs.mkdirSync(path.dirname(root),{recursive:true});fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(path.join(root,'private'),{mode:0o700});
const env=Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR','SYSTEMROOT','E2E_ISOLATED_CONTAINER','npm_config_cache','npm_config_offline','npm_config_registry','AGENT_INSIGHT_RAS_PYTHON','E2E_PYTHON','E2E_BROWSER_CHANNEL','E2E_NPM_REGISTRY','PLAYWRIGHT_BROWSERS_PATH','E2E_MODEL_BASE_URL','E2E_NPM_OFFLINE','E2E_PREPARED_PLUGIN_DIR','E2E_SKIP_TRACE_DATASET_CONCURRENCY_UT','PIP_NO_INDEX','PIP_FIND_LINKS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
env.E2E_SUITE_RUN_ID=runId;env.E2E_SUITE_OWNS_LANE='1';env.E2E_EXECUTION_CONFIG=JSON.stringify(config);env.E2E_CONFIG_PROVENANCE=JSON.stringify(executionSnapshot(config));env.E2E_LANE=executionProfile;
totalDeadline=setTimeout(stop,config.timeouts.runMs);totalDeadline.unref();
modelKeyFile=path.join(root,'private/model.key');
if(lane){env.E2E_LANE=lane.lane;env.E2E_STATE_ROOT=path.resolve(stateRoot);}
env.HOME=path.join(root,'private/home');fs.mkdirSync(env.HOME,{recursive:true});
env.AGENT_INSIGHT_HOME=path.join(root,'private/ut-data');env.DATABASE_URL='file:'+path.join(env.AGENT_INSIGHT_HOME,'data/witty_insight.db');
env.AGENT_INSIGHT_TEST_DATABASE_URL=env.DATABASE_URL;
const version=await command('git',['rev-parse','HEAD'],{cwd:project,env});
const dirty=await command('git',['status','--porcelain'],{cwd:project,env});
const metadata={runId,...(lane?{lane:lane.lane,account:lane.username}:{}),testedSha:version.output.trim(),dirtyWorkingTree:!!dirty.output.trim(),executionOrigin:process.env.E2E_ATOMGIT_JOB==='1'?'atomgit-job':'local-working-tree',configuration:executionSnapshot(config)};
const persist=async report=>{
  Object.assign(report,metadata);const safe=JSON.parse(redact(JSON.stringify(report)));const view=renderSummary(safe);
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(safe,null,2)+'\n');fs.writeFileSync(path.join(root,'report.html'),view.html);fs.writeFileSync(path.join(root,'summary.md'),view.markdown+'\n');
};
const runSelectedCase=async (id,mode=caseMode(config,id))=>{
    if(suiteStopping)return {status:'BLOCKED',reason:'总截止或用户中断，未启动场景'};
    if(mode==='real'&&!credentialWritten){fs.writeFileSync(modelKeyFile,readModelKey(config.model.key),{mode:0o600,flag:'wx'});credentialWritten=true;}
    console.log(id+': RUNNING');const childId=runId+'-'+id;
    const result=await command(process.execPath,['test/e2e/run-case.mjs','--case',id,'--mode',mode,...(mode==='real'?['--key-file',modelKeyFile]:[]),'--run-id',childId],{cwd:project,env,log:path.join(root,'private',id+'.log'),timeout:config.timeouts.caseMs,terminationGraceMs:config.timeouts.cleanupGraceMs});
    const orphanCleanup=await cleanupContainerOrphans();
    const reportFile=path.join(runDirectory(project,config,childId),'report.json');
    if(!fs.existsSync(reportFile))return {status:'BLOCKED',reason:'未生成场景报告，检查依赖与受限日志'};
    const child=JSON.parse(fs.readFileSync(reportFile));const row=child.scenarios.find(s=>s.id==='CORE-E2E-'+id);
    if(result.expired||!child.endedAt)return {status:'BLOCKED',reason:'场景超时或中断，原始阶段证据保留'};
    if(result.code!==0&&row?.status==='PASS')return {status:'FAIL',reason:'场景退出码非零，报告生成或清理异常'};
    console.log(id+': '+row?.status);return {...row,startedAt:child.startedAt,endedAt:child.endedAt,durationMs:Date.parse(child.endedAt)-Date.parse(child.startedAt),orphanCleanup,runId:childId,account:child.account,traces:child.traces||[]};
  };
const report=await executeSuite({mode:effectiveMode,caseModes:Object.fromEntries(selected.map(id=>[id,caseMode(config,id)])),selected,onUpdate:persist,isCancelled:()=>suiteStopping,
  runBuild:async()=>{if(process.env.E2E_PRODUCTION_BUILD_RESULT)return JSON.parse(process.env.E2E_PRODUCTION_BUILD_RESULT);const built=await compileProduction(config,{project,runId,env});return {...built,log:path.relative(root,path.join(project,'exclude/core-e2e/build-preflight/private/production-build.log'))};},
  runUt:!config.runUt?undefined:async()=>{
    console.log('UT: RUNNING');const log=path.join(root,'private/npm-test.log');
    fs.mkdirSync(path.join(env.AGENT_INSIGHT_HOME,'data'),{recursive:true});
    if(fs.existsSync(path.join(project,'prisma/schema.prisma'))){
      const prepared=await command(process.execPath,['node_modules/prisma/build/index.js','db','push','--skip-generate','--schema','prisma/schema.prisma'],{cwd:project,env,log,timeout:120000});
      if(prepared.code!==0)return {status:'BLOCKED',fullSuiteComplete:false,interrupted:prepared.expired,reason:'隔离 UT 数据库初始化失败，npm test 尚未执行'};
      if(process.env.E2E_ISOLATED_CONTAINER==='1'){const legacy=path.join(project,'data/witty_insight.db');fs.mkdirSync(path.dirname(legacy),{recursive:true});fs.copyFileSync(path.join(env.AGENT_INSIGHT_HOME,'data/witty_insight.db'),legacy,fs.constants.COPYFILE_EXCL);}
    }
    const execution=await command('npm',['test'],{cwd:project,env:boundedUtEnv(root,env,config.timeouts.utFileMs,env.E2E_ISOLATED_CONTAINER==='1'?config.resources.cpus:undefined),log,timeout});
    await cleanupContainerOrphans();
    const result={...parseUtResult(fs.readFileSync(log,'utf8'),execution),fileTimeoutMs:config.timeouts.utFileMs};console.log('UT:',result.status);return result;
  },
  runCase:runSelectedCase, runMockCase:runSelectedCase
});
console.log('Report:',path.join(root,'report.html'));process.exitCode=report.status==='PASS'?0:1;

}finally{clearTimeout(totalDeadline);cleanKey();lease?.release();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
