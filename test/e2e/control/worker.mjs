import {loadExecutionConfig,configSnapshot} from '../shared/config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runConfiguredSandbox } from './grouped-run.mjs';
import { Queue } from './queue.mjs';
import { prepareCheckout } from './checkout.mjs';
import { AtomGit } from './atomgit.mjs';
import { publishResult } from './publish.mjs';
import { runQueuedJob } from './worker-core.mjs';
import { command, stopCommands } from '../shared/runtime.mjs';
import { renderSummary } from '../shared/suite.mjs';
import {executeProbe,renderProbe} from './probe.mjs';

process.umask(0o077);
const {values}=parseArgs({options:{config:{type:'string'},'state-dir':{type:'string'},'lane-state-dir':{type:'string'},image:{type:'string'},'key-file':{type:'string'},publish:{type:'boolean'},'probe-only':{type:'boolean'},'report-base-url':{type:'string'}}});
if(!values['state-dir']||(!values.image&&!values['probe-only']))throw Error('--state-dir and --image sha256:... or --probe-only are required; processes one queued task per invocation');
const executionConfig=loadExecutionConfig({file:values.config,profile:'pr'});
const api=new AtomGit();
const state=path.resolve(values['state-dir']);fs.mkdirSync(state,{recursive:true,mode:0o700});
const lock=path.join(state,'worker.lock');const lockFd=fs.openSync(lock,'wx',0o600);fs.writeSync(lockFd,String(process.pid));fs.closeSync(lockFd);
let queue,stopping=false;
const stop=()=>{stopping=true;void stopCommands();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
try{
  queue=new Queue(path.join(state,'queue.sqlite'));
  queue.recover();const job=queue.claim();if(!job){console.log('Queue empty');process.exitCode=0;}
  else{
    const controlTiming={claimedAt:new Date().toISOString()};
    const work=path.join(state,'jobs',job.id);fs.mkdirSync(work,{recursive:true});
    const log=path.join(work,'private-worker.log');
    const env={PATH:process.env.PATH,HOME:path.join(work,'home'),GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_LFS_SKIP_SMUDGE:'1'};fs.mkdirSync(env.HOME,{recursive:true});
    const cmd=async(bin,args,cwd=work,timeout=120000)=>{const r=await command(bin,args,{env,cwd,log,timeout,maxLogBytes:67108864});if(r.code!==0)throw Error('Command failed; see private-worker.log');return r.output.trim();};
    const outcome=await runQueuedJob(job,{readPull:(repo,n)=>api.readPull(repo,n),isCurrent:()=>queue.get(job.id)?.state==='RUNNING',execute:async()=>{
      if(job.mode==='probe')return executeProbe(job,work);
      if(!job.configHash||job.configHash!==configSnapshot(executionConfig).hash)throw Object.assign(new Error('Queued configuration differs from trusted worker configuration'),{code:'E2E_CONFIG_MISMATCH'});
      if(values['probe-only'])throw Error('Probe-only worker refuses business execution');
      controlTiming.checkoutStartedAt=new Date().toISOString();
      const checkout=path.join(work,'checkout');
      const testedSha=await prepareCheckout(job,checkout,cmd);controlTiming.checkoutEndedAt=new Date().toISOString();
      for(const rel of ['',...fs.readdirSync(checkout,{recursive:true})]){const file=path.join(checkout,rel);const stat=fs.lstatSync(file);if(!stat.isSymbolicLink())fs.chmodSync(file,stat.isDirectory()?0o755:stat.mode|0o444);}
      const harness=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
      controlTiming.sandboxStartedAt=new Date().toISOString();
      const result=await runConfiguredSandbox({image:values.image,checkout,harness,job,work,testedSha,keyFile:values['key-file'],executionConfig:job.configHash?executionConfig:undefined,stateDirectory:values['lane-state-dir']||path.join(state,'lane-data'),lane:'pr'});
      controlTiming.sandboxEndedAt=new Date().toISOString();
      result.headSha=job.headSha;result.baseSha=job.baseSha;result.executionOrigin='isolated-pr-merge';return result;
    }});
    controlTiming.executionEndedAt=new Date().toISOString();outcome.result.controlTiming=controlTiming;
    if(job.mode!=='probe')outcome.result.configuration=configSnapshot(executionConfig);
    if(stopping){outcome.state='INTERRUPTED';outcome.result.status='BLOCKED';outcome.result.interrupted=true;}
    queue.finish(job.id,outcome.state,outcome.result);
    fs.writeFileSync(path.join(work,'report.json'),JSON.stringify(outcome.result,null,2));
    if(outcome.result.scenarios){const view=outcome.result.kind==='pipeline-probe'?renderProbe(outcome.result,job):renderSummary(outcome.result);fs.writeFileSync(path.join(work,'report.html'),view.html);fs.writeFileSync(path.join(work,'summary.md'),view.markdown);}
    if(!stopping&&values.publish&&outcome.state!=='SUPERSEDED'&&queue.get(job.id)?.state!=='SUPERSEDED'){
      const publishStartedAt=new Date().toISOString();
      const delivery=await publishResult(api,job,outcome.result,{reportUrl:values['report-base-url']?values['report-base-url'].replace(/\/$/,'')+'/'+job.id+'/report.html':undefined});
      fs.writeFileSync(path.join(work,'delivery.json'),JSON.stringify({...delivery,publishStartedAt,publishReadBackAt:new Date().toISOString()}));console.log('PR delivery:',delivery.status);
    }
    console.log('Job:',job.id,outcome.state,outcome.result.status);process.exitCode=outcome.result.status==='PASS'?0:1;
  }
}finally{queue?.close();fs.unlinkSync(lock);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
