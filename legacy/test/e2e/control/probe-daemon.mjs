import {loadExecutionConfig} from '../shared/config.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {parseArgs} from 'node:util';
import {Queue} from './queue.mjs';import {AtomGit} from './atomgit.mjs';import {publishResult} from './publish.mjs';import {probeCycle,recoverStaleLock} from './probe-daemon-core.mjs';import {command,stopCommands} from '../shared/runtime.mjs';
process.umask(0o077);
const {values}=parseArgs({options:{config:{type:'string'},'state-dir':{type:'string'},image:{type:'string'},'key-file':{type:'string'},'lane-state-dir':{type:'string'},'probe-only':{type:'boolean'},'poll-ms':{type:'string',default:'2000'}}});
if(!values['state-dir']||(!values['probe-only']&&!values.image))throw Error('--state-dir and either --probe-only or --image required');
const config=loadExecutionConfig({file:values.config,profile:'pr'});
const interval=Number(values['poll-ms']);if(!Number.isSafeInteger(interval)||interval<1000||interval>60000)throw Error('Invalid polling interval');
const state=path.resolve(values['state-dir']);fs.mkdirSync(state,{recursive:true,mode:0o700});recoverStaleLock(state,'supervisor.lock');const lock=path.join(state,'supervisor.lock');fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
let queue,stopping=false;const stop=()=>{stopping=true;void stopCommands({graceMs:90000});};process.once('SIGTERM',stop);process.once('SIGINT',stop);
try{
 recoverStaleLock(state,'worker.lock');queue=new Queue(path.join(state,'queue.sqlite'));queue.recover();const api=new AtomGit();
 const worker=fileURLToPath(new URL('./worker.mjs',import.meta.url)),project=path.resolve(path.dirname(worker),'../../..');
 console.log('Persistent PR daemon ready');
 while(!stopping){
  const result=await probeCycle({queue,state,allowedModes:values['probe-only']?['probe']:['probe','real','mock','mixed'],publish:(job,report)=>publishResult(api,job,report),runWorker:async()=>{
   const execution=await command(process.execPath,[worker,'--state-dir',state,...(values.config?['--config',values.config]:[]),...(values['probe-only']?['--probe-only']:['--image',values.image,...(values['key-file']?['--key-file',values['key-file']]:[]),'--lane-state-dir',values['lane-state-dir']||path.join(state,'lane-data')]),'--publish'],{cwd:project,env:process.env,log:path.join(state,'worker-process.log'),timeout:values['probe-only']?240000:config.timeouts.runMs+200000,maxLogBytes:1048576});
   console.log('Probe worker exit:',execution.code);
  }});
  if(result.executed||result.delivered||result.failed)console.log('Probe cycle:',JSON.stringify(result));
  if(!stopping)await new Promise(resolve=>setTimeout(resolve,interval));
 }
}finally{queue?.close();fs.unlinkSync(lock);}
