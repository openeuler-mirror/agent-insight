import {loadExecutionConfig,configSnapshot,caseMode,suiteMode} from '../shared/config.mjs';
import {selectedCases,assertSelection} from '../shared/selection.mjs';
import path from 'node:path';
import { cases } from '../shared/catalog.mjs';
import { scenarioResult } from '../shared/core.mjs';
import {failedProbe} from './probe.mjs';

export function extractContainerReport(output){
  const line=output.split('\n').filter(line=>line.startsWith('E2E_REPORT_JSON:')).at(-1);
  if(!line||line.length>1048576)throw Error('Container report missing or too large');
  return JSON.parse(line.slice('E2E_REPORT_JSON:'.length));
}

export function dockerArgs({image,checkout,harness,job,name='agent-insight-pr-'+job.id,network,stateDirectory,tokenFile,lane='pr',caseId,skipUt=false,dependencyVolume,workspace,executionConfig,buildOnly=false,productionBuild}){
  if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Runner image must be pinned to its local digest');
  dependencyVolume ||= 'agent-insight-e2e-deps-'+image.slice(7,23);
  if(!/^agent-insight-e2e-deps-[a-f0-9]{16}$/.test(dependencyVolume))throw Error('Invalid dependency volume');
  const cfg=executionConfig||loadExecutionConfig({profile:lane}),r=cfg.resources;
  const mounts=[`type=volume,src=${dependencyVolume},dst=/work/node_modules,readonly`,`type=bind,src=${path.resolve(checkout)},dst=/source,readonly`];
  if(workspace)mounts.push(`type=bind,src=${path.resolve(workspace)},dst=/work,readonly=false`);
  if(productionBuild)mounts.push(`type=bind,src=${path.resolve(productionBuild.artifactDirectory)},dst=/compiled,readonly`);
  if(harness)mounts.push(`type=bind,src=${path.resolve(harness)},dst=/runner,readonly`);
  const real=job.mode==='real';
  if(real&&(!/^agent-insight-e2e-[a-z0-9-]+$/.test(network||'')||!stateDirectory||!tokenFile||!['pr','daily'].includes(lane)))throw Error('Real mode requires an isolated model relay and lane storage');
  if(real||executionConfig&&stateDirectory)mounts.push(`type=bind,src=${path.resolve(stateDirectory)},dst=/state-seed,readonly`);
  if(real){mounts.push(`type=bind,src=${path.resolve(tokenFile)},dst=/run/e2e-relay.key,readonly`);}
  if(job.profile)selectedCases(job.profile);
  if(caseId&&job.profile)throw Error('Case and profile cannot be combined');
  if(caseId&&!/^00[1-5]$/.test(caseId))throw Error('Invalid case ID');
  if(mounts.some(m=>m.split(',').length!==4))throw Error('Commas are not supported in mount paths');
  return ['run','--init','--log-driver=none','--name',name,'--label','agent-insight.e2e='+job.id,'--network',real?network:'none','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory='+r.memoryMiB+'m','--memory-swap='+r.memoryMiB+'m','--cpus='+r.cpus,'--ulimit',`nofile=${r.openFiles}:${r.openFiles}`,'--pids-limit='+r.pids,'--user=1000:1000',
    ...(workspace?[]:['--tmpfs','/work:rw,exec,uid=1000,gid=1000,size=4g']),'--tmpfs',`/tmp:rw,exec,uid=1000,gid=1000,size=${r.tmpMiB}m`,'--tmpfs','/output:rw,uid=1000,gid=1000,size=32m','--tmpfs',`/state:rw,uid=1000,gid=1000,size=${r.stateMiB}m`,
    ...['.prisma','@prisma','prisma'].flatMap(name=>['--tmpfs',`/work/node_modules/${name}:rw,exec,uid=1000,gid=1000,size=${r.prismaMiB}m`]),...mounts.flatMap(m=>['--mount',m]),...(executionConfig?['--env','E2E_EXECUTION_CONFIG='+JSON.stringify(executionConfig),'--env','E2E_CONFIG_PROVENANCE='+JSON.stringify(configSnapshot(executionConfig))]:[]),...(buildOnly?['--env','E2E_BUILD_ONLY=1']:[]),...(productionBuild?['--env','E2E_PREBUILT_FINGERPRINT='+productionBuild.sourceFingerprint]:[]),'--env','HOME=/tmp/e2e-home','--env','E2E_RUN_ID='+(job.runId||'pr-'+job.id),'--env','E2E_MODE='+ (job.mode||'mock'),...(executionConfig||real?['--env','E2E_LANE='+lane]:[]),...(real||executionConfig&&stateDirectory?['--env','E2E_STATE_ROOT=/state']:[]),...(real?['--env','E2E_MODEL_BASE_URL=http://model-relay:8080']:[]),'--env','PIP_NO_INDEX=1','--env','PIP_FIND_LINKS=/opt/wheels','--env','E2E_NPM_OFFLINE=1','--env','E2E_PREPARED_PLUGIN_DIR=/opt/ras-plugin',...(job.profile?['--env','E2E_PROFILE='+job.profile]:[]),...(caseId?['--env','E2E_CASE_ID='+caseId]:[]),...(skipUt||executionConfig?.runUt===false?['--env','E2E_SKIP_UT=1']:[]),'--env','E2E_BROWSER_CHANNEL=chromium','--env','E2E_PYTHON=/usr/bin/python3','--env','PLAYWRIGHT_BROWSERS_PATH=/opt/browsers',image,'node','/runner/control/container.mjs'];
}
export function validateReport(report,{job,testedSha,exitCode,caseId}){
  if(report.testedSha!==testedSha)throw Error('Report SHA mismatch');
  if(report.mode!==(job.mode||'real')||report.runId!==(job.runId||'pr-'+job.id)||!report.endedAt)throw Error('Report identity or completion mismatch');
  if(report.scenarios?.length!==cases.length||cases.some(c=>report.scenarios.filter(s=>s.id===c.id).length!==1))throw Error('Expected five unique scenario results');
  const selected=assertSelection(report,job.profile,caseId,job.caseIds);
  if(job.configHash&&(report.configuration?.hash!==job.configHash||configSnapshot(report.configuration.settings).hash!==job.configHash))throw Error('Report configuration mismatch');
  if(job.configHash&&report.mode==='mixed'&&(suiteMode(report.configuration.settings)!=='mixed'||report.scenarios.some(row=>selected.includes(row.id)&&row.mode!==caseMode(report.configuration.settings,row.id))))throw Error('Report case mode mismatch');
  if(report.status==='PASS'){
    if(exitCode!==0)throw Error('Successful report contradicts process exit');
    const ut=report.npmTest,c=ut?.observedSummary;
    if(job.runUt!==false&&(ut?.status!=='PASS'||!ut.fullSuiteComplete||ut.interrupted||!c||c.tests<=0||c.pass<=0||c.fail!==0||c.cancelled!==0||c.tests!==c.pass+c.skipped+(c.todo||0)))throw Error('Invalid successful UT evidence');
    if(job.runUt===false&&ut?.status!=='NOT_RUN')throw Error('Unexpected UT execution outside configured scope');
    if(report.scenarios.filter(s=>selected.includes(s.id)).some(s=>s.status!=='PASS'))throw Error('Incomplete scenario results');
    if(report.scenarios.filter(s=>selected.includes(s.id)).some(s=>scenarioResult(s.stages||[],s.id).status!=='PASS'))throw Error('Missing required scenario stages');
  }
  return report;
}
export function blockedReport(job,reason,testedSha){return {runId:job.runId||'pr-'+job.id,mode:job.mode||'real',selected:job.caseIds||selectedCases(job.profile),testedSha,status:'BLOCKED',startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),npmTest:{status:'NOT_RUN',fullSuiteComplete:false},scenarios:cases.map(c=>({id:c.id,title:c.title,status:(job.caseIds||selectedCases(job.profile)).includes(c.id)?'BLOCKED':'NOT_RUN',reason:(job.caseIds||selectedCases(job.profile)).includes(c.id)?reason:'按本轮范围配置未执行',stages:[]}))};}
export async function runQueuedJob(job,{readPull,execute,isCurrent}){
  const fresh=async()=>{const pr=await readPull(job.repository,job.pr);return isCurrent()&&['open','opened'].includes(pr.state)&&pr.head?.sha===job.headSha&&pr.base?.sha===job.baseSha;};
  let result,executionStarted=false;
  try{if(!await fresh())return {state:'SUPERSEDED',result:{status:'NOT_RUN'}};
    executionStarted=true;result=await execute(job);if(!await fresh())return {state:'SUPERSEDED',result};return {state:'COMPLETED',result};}
  catch(error){
    if(job.mode==='probe')return result?{state:'COMPLETED',result,verificationPending:true}:{state:'ERROR',result:failedProbe(job,executionStarted)};
    if(result)return {state:'COMPLETED',result,verificationPending:true};
    return {state:'ERROR',result:blockedReport(job,error?.code==='E2E_CONFIG_MISMATCH'?'任务配置缺失或与当前可信配置不一致，请按当前配置重新触发':'隔离执行失败；检查控制端受限日志，不能算通过')};
  }
}
