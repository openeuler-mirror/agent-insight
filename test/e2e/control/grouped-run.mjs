import {gateProductionBuild} from './build-gate.mjs';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {caseMode,suiteMode,executionGroups,configSnapshot,validateExecutionConfig} from '../shared/config.mjs';
import {cases} from '../shared/catalog.mjs';import {scenarioResult} from '../shared/core.mjs';import {runSandbox} from './isolated-run.mjs';import {blockedReport} from './worker-core.mjs';

export function mergeGroupReports(reports,{config,job,testedSha}) {
 const selected=config.cases,seen=new Set();
 const scenarios=cases.map(c=>({id:c.id,title:c.title,status:'NOT_RUN',reason:c.mergedInto?'已并入 '+c.mergedInto+'，本轮不重复执行':'按本轮范围配置未执行',stages:[]}));
 for(const report of reports){
  if(report.testedSha!==testedSha)throw Error('Group source SHA mismatch');
  for(const id of report.selected||[]){
   if(!selected.includes(id)||seen.has(id)||caseMode(config,id)!==report.mode)throw Error('Group case or model mode mismatch');seen.add(id);
   const row=report.scenarios.find(row=>row.id===id);if(!row)throw Error('Group case report missing');
   const target=scenarios.find(row=>row.id===id);delete target.reason;Object.assign(target,row,{mode:report.mode});
   if(row.status==='PASS')Object.assign(target,scenarioResult(row.stages||[],id));
  }
 }
 if(selected.some(id=>!seen.has(id)))throw Error('Missing group cases');
 const utReports=reports.filter(report=>report.npmTest?.status!=='NOT_RUN');if(utReports.length>(config.runUt?1:0))throw Error('UT must execute exactly once');
 const npmTest=utReports[0]?.npmTest||{status:'NOT_RUN'},historyPreserved=reports.every(report=>report.historyPreserved===true);
 const results=[...scenarios.filter(row=>selected.includes(row.id)),...(config.runUt?[npmTest]:[])];
 const status=results.some(row=>row.status==='FAIL')?'FAIL':historyPreserved&&results.every(row=>row.status==='PASS')?'PASS':'BLOCKED';
 const events={};for(const report of reports)for(const line of String(report.resources?.['memory.events']||'').trim().split('\n')){const [key,value]=line.split(/\s+/);if(key&&/^\d+$/.test(value||''))events[key]=(events[key]||0)+Number(value);}
 return {runId:job.runId||job.id,mode:suiteMode(config),selected,testedSha,status,scenarios,npmTest,historyPreserved,dirtyWorkingTree:reports.some(report=>report.dirtyWorkingTree===true),startedAt:reports[0]?.startedAt,endedAt:new Date().toISOString(),e2eStartedAt:reports[0]?.e2eStartedAt,e2eEndedAt:reports.at(-1)?.e2eEndedAt,e2eDurationMs:reports.reduce((sum,report)=>sum+(report.e2eDurationMs||0),0),configuration:configSnapshot(config),groups:reports.map(report=>({runId:report.runId,mode:report.mode,selected:report.selected,status:report.status,historyPreserved:report.historyPreserved,resources:report.resources})),resources:{'memory.peak':String(Math.max(0,...reports.map(report=>Number(report.resources?.['memory.peak']||0)))),'memory.events':Object.entries(events).map(([key,value])=>key+' '+value).join('\n')+'\n'}};
}

async function runGroups(options,{run=runSandbox}={}) {
 const config=options.executionConfig,groups=executionGroups(config,options.caseId?[options.caseId]:config.cases);
 const groupOptions=(group,index,work,executorLease)=>{
  const executionConfig=validateExecutionConfig({...config,mode:group.mode,caseModes:{},cases:group.cases,runUt:config.runUt&&index===0,...(group.mode==='mock'?{model:{...config.model,key:{env:'E2E_MOCK_UNUSED_KEY'}}}:{})});
  const runId=(options.job.runId||options.job.id)+(groups.length>1?'-'+group.mode:'');
  return {...options,executorLease,caseId:groups.length>1?undefined:options.caseId,work,executionConfig,keyFile:group.mode==='real'?options.keyFile:undefined,skipUt:!executionConfig.runUt,job:{...options.job,id:runId,runId,mode:group.mode,caseIds:group.cases,runUt:executionConfig.runUt,configHash:configSnapshot(executionConfig).hash}};
 };
 if(groups.length===1){const input=groupOptions(groups[0],0,options.work,options.executorLease);if(options.deadline){const remaining=options.deadline-Date.now();if(remaining<1000)throw Error('Suite total deadline expired before group start');input.executionConfig.timeouts={...input.executionConfig.timeouts,runMs:remaining,caseMs:Math.min(config.timeouts.caseMs,remaining),modelRequestMs:Math.min(config.timeouts.modelRequestMs,remaining)};input.job.configHash=configSnapshot(input.executionConfig).hash;}const result=await run(input);result.mode=groups[0].mode;for(const row of result.scenarios||[])if(groups[0].cases.includes(row.id))row.mode=groups[0].mode;result.configuration=configSnapshot(config);return result;}
 fs.mkdirSync(options.work,{recursive:true,mode:0o700});fs.mkdirSync(options.stateDirectory,{recursive:true,mode:0o700});
 const lock=path.join(options.stateDirectory,'executor.lock'),executorLease=options.executorLease||{token:randomUUID(),runId:options.job.runId||options.job.id,stateDirectory:path.resolve(options.stateDirectory)};
 if(!options.executorLease)fs.writeFileSync(lock,JSON.stringify({...executorLease,pid:process.pid,lane:options.lane}),{flag:'wx',mode:0o600});
 const reports=[],deadline=options.deadline||Date.now()+config.timeouts.runMs,allEvidence={files:[],omitted:[]};
 try{
  for(const [index,group]of groups.entries()){
   const work=path.join(options.work,'groups',group.mode);fs.mkdirSync(work,{recursive:true,mode:0o700});const input=groupOptions(group,index,work,executorLease);
   let report;try{
    const remaining=deadline-Date.now();if(remaining<1000)throw Error('Suite total deadline expired before group start');
    input.executionConfig.timeouts={...input.executionConfig.timeouts,runMs:remaining,caseMs:Math.min(config.timeouts.caseMs,remaining),modelRequestMs:Math.min(config.timeouts.modelRequestMs,remaining)};input.job.configHash=configSnapshot(input.executionConfig).hash;
    report=await run(input);
   }catch(error){fs.writeFileSync(path.join(work,'controller-error.txt'),String(error.message),{mode:0o600});report=blockedReport(input.job,'隔离分组执行失败；查看本组受限日志',options.testedSha);}
   reports.push(report);fs.writeFileSync(path.join(work,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
   const evidence=path.join(work,'private-evidence');if(fs.existsSync(evidence)){
    const manifest=JSON.parse(fs.readFileSync(path.join(evidence,'manifest.json'),'utf8')),destination=path.join(options.work,'private-evidence');fs.mkdirSync(destination,{recursive:true,mode:0o700});
    for(const file of manifest.files){if(allEvidence.files.includes(file))throw Error('Duplicate group evidence path');const target=path.join(destination,file);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(path.join(evidence,file),target,fs.constants.COPYFILE_EXCL);allEvidence.files.push(file);}
    allEvidence.omitted.push(...manifest.omitted);fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(allEvidence,null,2),{mode:0o600});
   }
   const relay=path.join(work,'model-relay.log');if(fs.existsSync(relay))fs.copyFileSync(relay,path.join(options.work,'model-relay.log'));
   fs.writeFileSync(path.join(options.work,'group-progress.json'),JSON.stringify({groups:reports,activeGroup:groups[index+1]?.mode||null}),{mode:0o600});
  }
  const merged=mergeGroupReports(reports,{config,job:options.job,testedSha:options.testedSha});
  fs.writeFileSync(path.join(options.work,'isolation.json'),JSON.stringify({grouped:true,groups:groups.map(group=>({mode:group.mode,cases:group.cases,isolation:path.join('groups',group.mode,'isolation.json')}))},null,2),{mode:0o600});return merged;
 }finally{if(!options.executorLease&&fs.existsSync(lock)&&JSON.parse(fs.readFileSync(lock,'utf8')).token===executorLease.token)fs.unlinkSync(lock);}
}

export async function runConfiguredSandbox(options,{run=runSandbox,build=runProductionPreflight}={}) {
 fs.mkdirSync(options.work,{recursive:true,mode:0o700});fs.mkdirSync(options.stateDirectory,{recursive:true,mode:0o700});
 const lock=path.join(options.stateDirectory,'executor.lock'),executorLease={token:randomUUID(),runId:options.job.runId||options.job.id,stateDirectory:path.resolve(options.stateDirectory)};
 fs.writeFileSync(lock,JSON.stringify({...executorLease,pid:process.pid,lane:options.lane}),{flag:'wx',mode:0o600});
 try{return await gateProductionBuild({...options,executorLease,deadline:Date.now()+options.executionConfig.timeouts.runMs},{build,run:input=>runGroups(input,{run})});}
 finally{if(fs.existsSync(lock)&&JSON.parse(fs.readFileSync(lock,'utf8')).token===executorLease.token)fs.unlinkSync(lock);}
}
async function runProductionPreflight(options){
 const executionConfig=validateExecutionConfig({...options.executionConfig,mode:'mock',caseModes:{},runUt:false,model:{...options.executionConfig.model,key:{env:'E2E_MOCK_UNUSED_KEY'}}});
 return runSandbox({...options,work:path.join(options.work,'build'),executionConfig,buildOnly:true,keyFile:undefined,job:{...options.job,id:options.job.id+'-build',runId:(options.job.runId||options.job.id)+'-build',mode:'mock'}});
}
