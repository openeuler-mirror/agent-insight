import {loadExecutionConfig,executionSnapshot} from '../shared/config.mjs';
import {selectedCases} from '../shared/selection.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareDependencies } from './dependencies.mjs';
import { collectState } from './state-transfer.mjs';
import { collectEvidence } from './evidence.mjs';
import { cases } from '../shared/catalog.mjs';

const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cfg=loadExecutionConfig({profile:process.env.E2E_LANE||'pr'});
const configured=!!process.env.E2E_EXECUTION_CONFIG;
const mode=process.env.E2E_MODE||cfg.mode;
if(!['mock','real'].includes(mode))throw Error('Invalid mode');
const selected=process.env.E2E_CASE_ID?[process.env.E2E_CASE_ID]:configured?cfg.cases:selectedCases(process.env.E2E_PROFILE);
const scenarioRows=reason=>cases.map(c=>({id:c.id,title:c.title,status:selected.includes(c.id)?'BLOCKED':'NOT_RUN',reason:selected.includes(c.id)?reason:'按本轮范围配置未执行',stages:[]}));
let report;
try{
  if(process.env.E2E_STATE_ROOT){fs.cpSync('/state-seed','/state',{recursive:true,verbatimSymlinks:true});const lane=process.env.E2E_LANE;if(!['pr','daily'].includes(lane))throw Error('Invalid lane');fs.mkdirSync('/state/'+lane,{recursive:true});const marker='/state/'+lane+'/.e2e-lane';if(fs.existsSync(marker)&&fs.readFileSync(marker,'utf8').trim()!==cfg.account.username)throw Error('Configured account differs from retained state');fs.writeFileSync(marker,cfg.account.username);fs.mkdirSync('/state/'+lane+'/app',{recursive:true});fs.writeFileSync('/state/'+lane+'/app/.e2e-account',cfg.account.username);}
  fs.cpSync('/source','/work',{recursive:true,dereference:false,verbatimSymlinks:true});process.chdir('/work');fs.mkdirSync(process.env.HOME,{recursive:true});
  const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
  if(revision.status!==0||!revision.stdout?.trim())throw Error('Cannot resolve checkout revision; Git must be installed and checkout readable');
  const sha=revision.stdout.trim();
  const blocked=reason=>({runId:process.env.E2E_RUN_ID,mode,selected,testedSha:sha,status:'BLOCKED',endedAt:new Date().toISOString(),npmTest:{status:'NOT_RUN',fullSuiteComplete:false},scenarios:scenarioRows(reason)});
  if(!fs.existsSync('test/e2e/run.mjs'))report=blocked('本次 PR 尚未包含统一 E2E 入口');
  else if(hash('package-lock.json')!==hash('/opt/dependencies/package-lock.json')||hash('test/e2e/package-lock.json')!==hash('/opt/e2e/package-lock.json')||hash('prisma/schema.prisma')!==hash('/opt/dependencies/prisma/schema.prisma'))report=blocked('依赖锁或 Prisma schema 与可信测试镜像不一致；需重建测试镜像');
  else{
    process.env.E2E_ISOLATED_CONTAINER='1';process.env.AGENT_INSIGHT_RAS_PYTHON='/opt/e2e-python/bin/python3';
    {const cache=path.resolve('exclude/core-e2e/cache/npm');fs.cpSync('/opt/fi-npm-cache',cache,{recursive:true});process.env.npm_config_cache=cache;process.env.npm_config_offline='true';process.env.npm_config_registry='https://registry.npmjs.org';}
    prepareDependencies('/opt/dependencies/node_modules',path.resolve('node_modules'));fs.symlinkSync('/opt/e2e/node_modules','test/e2e/node_modules');
    fs.mkdirSync('exclude/core-e2e/runtime/v2',{recursive:true});fs.symlinkSync('/opt/opencode-v2/node_modules','exclude/core-e2e/runtime/v2/node_modules');
    if(!process.env.E2E_SKIP_UT){const built=spawnSync('npm',['run','compile','--prefix','scripts/trae-collector'],{stdio:'inherit',timeout:120000,env:{...process.env,npm_config_offline:'true'}});if(built.status!==0)throw Error('TRAE collector test artifact build failed');}
    const args=['test/e2e/run.mjs',...(configured&&!process.env.E2E_CASE_ID?[]:process.env.E2E_PROFILE?['--profile',process.env.E2E_PROFILE]:process.env.E2E_CASE_ID?['--case',process.env.E2E_CASE_ID]:['--all']),'--mode',mode,...(process.env.E2E_SKIP_UT?['--skip-ut']:['--ut']),'--run-id',process.env.E2E_RUN_ID,...(mode==='real'?['--key-file','/run/e2e-relay.key']:[])];
    if(process.env.E2E_STATE_ROOT)args.push('--lane',process.env.E2E_LANE,'--state-dir','/state');
    const run=spawnSync(process.execPath,args,{stdio:'inherit',timeout:cfg.timeouts.runMs});
    const file=path.join(cfg.storage.reportsDir,process.env.E2E_RUN_ID,'report.json');
    if(!fs.existsSync(file)||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>524288)report=blocked('测试未生成有效的完整报告');
    else report=JSON.parse(fs.readFileSync(file,'utf8'));
    if(run.error||run.signal){report.status='BLOCKED';if(report.npmTest?.status==='RUNNING')report.npmTest={...report.npmTest,status:'BLOCKED',interrupted:true,fullSuiteComplete:false};}
    else if(run.status!==0&&report.status==='PASS')report.status='FAIL';
  }
}catch(error){console.error('Container preparation:',error.message);report={runId:process.env.E2E_RUN_ID,mode,selected,status:'BLOCKED',endedAt:new Date().toISOString(),npmTest:{status:'NOT_RUN'},scenarios:scenarioRows('测试容器准备失败')};}
report.configuration=executionSnapshot(cfg);
report.resources=Object.fromEntries(['memory.events','memory.peak'].map(name=>{try{return [name,fs.readFileSync('/sys/fs/cgroup/'+name,'utf8')];}catch{return [name,null];}}));
if(process.env.E2E_STATE_ROOT){try{process.stdout.write('\nE2E_STATE_JSON:'+JSON.stringify(collectState('/state',process.env.E2E_LANE))+'\n');}catch(error){report.status='BLOCKED';report.stateExportError=error.message;}}
try{process.stdout.write('\nE2E_EVIDENCE_JSON:'+JSON.stringify(collectEvidence(path.join('/work',cfg.storage.reportsDir),process.env.E2E_RUN_ID))+'\n');}
catch{report.status='BLOCKED';report.evidenceError='证据导出失败';}
process.stdout.write('\nE2E_REPORT_JSON:'+JSON.stringify(report)+'\n');process.exitCode=report.status==='PASS'?0:1;
