import {loadExecutionConfig,configSnapshot,suiteMode} from '../shared/config.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {parseArgs} from 'node:util';import {spawnSync} from 'node:child_process';
import {runConfiguredSandbox} from './grouped-run.mjs';import {blockedReport} from './worker-core.mjs';import {renderSummary} from '../shared/suite.mjs';
process.umask(0o077);
const {values}=parseArgs({options:{config:{type:'string'},mode:{type:'string'},source:{type:'string'},image:{type:'string'},'state-dir':{type:'string'},'key-file':{type:'string'},'run-id':{type:'string'},lane:{type:'string'},case:{type:'string'},'skip-ut':{type:'boolean'}}});
if(!values.source||!values.image||!values['state-dir']||!['pr','daily'].includes(values.lane)||!/^[-a-z0-9]{1,80}$/.test(values['run-id']||''))throw Error('Required: --source --image --state-dir --key-file --run-id --lane pr|daily');
const checkout=path.resolve(values.source),state=path.resolve(values['state-dir']);
const query=(bin,args)=>{const r=spawnSync(bin,args,{encoding:'utf8',timeout:30000});if(r.status!==0)throw Error('Cannot resolve source or image');return r.stdout.trim();};
const image=query('docker',['image','inspect',values.image,'--format','{{.Id}}']),testedSha=query('git',['-C',checkout,'rev-parse','HEAD']);
const config=loadExecutionConfig({file:values.config,profile:values.lane,overrides:{...(values.mode?{mode:values.mode}:{}),...(values['skip-ut']?{runUt:false}:{})}});
if(values.case)config.cases=[values.case];
const job={caseIds:config.cases,runUt:config.runUt,configHash:configSnapshot(config).hash,id:values['run-id'],runId:values['run-id'],mode:suiteMode(config),headSha:testedSha,baseSha:testedSha};const work=path.join(state,'jobs',job.id);fs.mkdirSync(path.dirname(work),{recursive:true,mode:0o700});fs.mkdirSync(work,{mode:0o700});
let report;try{report=await runConfiguredSandbox({image,checkout,harness:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),job,work,testedSha,executionConfig:config,keyFile:values['key-file']?path.resolve(values['key-file']):undefined,stateDirectory:path.join(state,'lane-data'),lane:values.lane,caseId:values.case,skipUt:values['skip-ut']});}
catch(error){fs.writeFileSync(path.join(work,'controller-error.txt'),error.message,{mode:0o600});report=blockedReport(job,'隔离执行或证据导出失败，查看受限控制日志',testedSha);}
report.executionOrigin='server-isolated-source-snapshot';report.lane=values.lane;report.account=config.account.username;report.configuration=configSnapshot(config);const view=renderSummary(report);fs.writeFileSync(path.join(work,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(work,'report.html'),view.html);fs.writeFileSync(path.join(work,'summary.md'),view.markdown);console.log(view.markdown);console.log('Report:',path.join(work,'report.html'));process.exitCode=report.status==='PASS'?0:1;
