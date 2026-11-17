import {sourceFingerprint,validateBuildArtifact,writeBuildManifest} from '../shared/build-artifact.mjs';
import {loadExecutionConfig,configSnapshot,readModelKey} from '../shared/config.mjs';
import {assertMemoryHeadroom} from './host-capacity.mjs';
import {createWorkspace} from './workspace.mjs';
import {ensureDependencyVolume} from './dependencies.mjs';
import {extractState,saveState,verifyHistory,assertStateAccount} from './state-transfer.mjs';
import fs from 'node:fs';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';
import {command} from '../shared/runtime.mjs';import {redact} from '../shared/core.mjs';import {dockerArgs,extractContainerReport,validateReport} from './worker-core.mjs';import {extractEvidence,saveEvidence} from './evidence.mjs';
export async function runSandbox({image,checkout,harness,job,work,testedSha,keyFile,stateDirectory,lane='pr',caseId,skipUt=false,executionConfig,executorLease,buildOnly=false,productionBuild}){
 const suffix=randomUUID().slice(0,8),name='agent-insight-e2e-job-'+suffix,network='agent-insight-e2e-'+suffix,relay='agent-insight-e2e-model-'+suffix;
 const log=path.join(work,'private-worker.log'),env={PATH:process.env.PATH,HOME:process.env.HOME};fs.mkdirSync(work,{recursive:true,mode:0o700});
 const docker=async(args,timeout=120000)=>{const result=await command('docker',args,{env,cwd:work,log,timeout,maxLogBytes:67108864});if(result.code!==0)throw Error('Docker operation failed; see private-worker.log');return result.output.trim();};
 const cfg=executionConfig||loadExecutionConfig({profile:lane}),r=cfg.resources;
 const real=!buildOnly&&job.mode==='real',persistent=!buildOnly&&(real||!!executionConfig);let networkCreated=false,relayCreated=false,laneLock,executorLock,seed,channel,workspace,exported=false;const tokenFile=path.join(work,'relay-token.key'),relayKeyFile=path.join(work,'model-credential.key');
 try{
  if(persistent){
   if(!stateDirectory)throw Error('Real execution requires model relay key and isolated lane data');
   fs.mkdirSync(stateDirectory,{recursive:true,mode:0o700});const executorCandidate=path.join(stateDirectory,'executor.lock');if(executorLease){const owner=JSON.parse(fs.readFileSync(executorCandidate,'utf8'));if(owner.token!==executorLease.token||executorLease.stateDirectory!==path.resolve(stateDirectory))throw Error('Invalid executor lease');}else{const executorFd=fs.openSync(executorCandidate,'wx',0o600);executorLock=executorCandidate;fs.writeSync(executorFd,JSON.stringify({pid:process.pid,lane,runId:job.runId||job.id}));fs.closeSync(executorFd);}
   channel=path.join(stateDirectory,lane);fs.mkdirSync(channel,{recursive:true,mode:0o700});const candidateLock=path.join(channel,'control.lock');const lockFd=fs.openSync(candidateLock,'wx',0o600);laneLock=candidateLock;fs.writeSync(lockFd,JSON.stringify({pid:process.pid,runId:job.runId||job.id}));fs.closeSync(lockFd);
   const pointer=path.join(channel,'current.json');seed=fs.existsSync(pointer)?JSON.parse(fs.readFileSync(pointer)).path:path.join(channel,'empty');fs.mkdirSync(seed,{recursive:true,mode:0o755});if(process.getuid?.()===0)fs.chownSync(seed,1000,1000);
   assertStateAccount(seed,lane,cfg.account.username);
  }
  if(real){
   fs.writeFileSync(tokenFile,'sk-e2e-'+randomBytes(32).toString('hex'),{flag:'wx',mode:0o400});
   fs.writeFileSync(relayKeyFile,readModelKey(keyFile?{file:path.resolve(keyFile)}:cfg.model.key),{flag:'wx',mode:0o400});
   if(process.getuid?.()===0){fs.chownSync(tokenFile,1000,1000);fs.chownSync(relayKeyFile,1000,1000);}
   for(const value of [relayKeyFile,tokenFile,harness])if(value.includes(','))throw Error('Unsupported mount path');
   await docker(['network','create','--internal','--label','agent-insight.e2e='+job.id,network]);networkCreated=true;
   await docker(['create','--name',relay,'--network',network,'--network-alias','model-relay','--read-only','--user','1000:1000','--cap-drop=ALL','--security-opt','no-new-privileges','--memory='+r.relayMemoryMiB+'m','--cpus='+r.relayCpus,'--pids-limit=64','--log-driver=json-file','--log-opt','max-size=1m','--log-opt','max-file=1','--mount',`type=bind,src=${relayKeyFile},dst=/run/model.key,readonly`,'--mount',`type=bind,src=${tokenFile},dst=/run/token.key,readonly`,'--mount',`type=bind,src=${harness},dst=/runner,readonly`,'--env','E2E_EXECUTION_CONFIG='+JSON.stringify(cfg),image,'node','/runner/control/model-relay-server.mjs','--lane',lane,'--key-file','/run/model.key','--token-file','/run/token.key']);relayCreated=true;
   await docker(['network','connect','bridge',relay]);await docker(['start',relay]);
  }
  assertMemoryHeadroom(fs.readFileSync('/proc/meminfo','utf8'),r);
  workspace=await createWorkspace(work,async(bin,args)=>{const result=await command(bin,args,{env,cwd:work,log,timeout:120000,maxLogBytes:67108864});if(result.code!==0)throw Error('Disk workspace setup or cleanup failed');},r);
  const dependencyVolume=await ensureDependencyVolume(docker,image);
  const args=dockerArgs({buildOnly,productionBuild,executionConfig:executionConfig?{...cfg,...(real?{model:{...cfg.model,baseUrl:'http://model-relay:8080',key:{file:'/run/e2e-relay.key'}}}:{})}:undefined,image,dependencyVolume,workspace:workspace.mount,checkout,harness,job,name,...(persistent?{stateDirectory:seed,lane}:{}),...(real?{network,tokenFile}:{}),caseId,skipUt});
  if(executionConfig){const index=args.findIndex(v=>v.startsWith('E2E_CONFIG_PROVENANCE='));args[index]='E2E_CONFIG_PROVENANCE='+JSON.stringify(configSnapshot(cfg));}
  const execution=await command('docker',args,{env,cwd:work,log,timeout:cfg.timeouts.runMs+60000,maxOutputChars:268435456,maxLogBytes:67108864});
  if(execution.expired)throw Error('Container deadline exceeded; incomplete execution');
  if(buildOnly){
   const line=execution.output.split('\n').filter(line=>line.startsWith('E2E_BUILD_JSON:')).at(-1);if(!line)throw Error('Production build report missing');
   const result=JSON.parse(line.slice('E2E_BUILD_JSON:'.length));
   const privateBuild=path.join(work,'private-build');fs.mkdirSync(privateBuild,{recursive:true,mode:0o700});await docker(['cp',name+':/work/exclude/core-e2e/build-preflight/private/.',privateBuild]);
   if(result.status==='PASS'){
    if(execution.code!==0||result.sourceFingerprint!==sourceFingerprint(checkout))throw Error('Production build provenance mismatch');
    const artifactDirectory=path.join(work,'production-build');fs.mkdirSync(artifactDirectory,{recursive:true,mode:0o755});
    await docker(['cp',name+':/work/.next',artifactDirectory]);await docker(['cp',name+':/work/generated',artifactDirectory]);
    writeBuildManifest(artifactDirectory,result);validateBuildArtifact(artifactDirectory,result.sourceFingerprint);result.artifactDirectory=artifactDirectory;
   }
   exported=true;return result;
  }
  saveEvidence(path.join(work,'private-evidence'),extractEvidence(execution.output));
  const rawReport=extractContainerReport(execution.output);
  if(caseId&&rawReport.status==='PASS')rawReport.status='PARTIAL';
  const report=validateReport(rawReport,{job,testedSha,exitCode:execution.code,caseId});
  exported=!persistent;
  if(persistent){try{const saved=path.join(work,'private-state');saveState(saved,extractState(execution.output),lane);exported=true;verifyHistory(seed,saved,lane,cfg.account.username);const pointer=path.join(channel,'current.json'),temp=pointer+'.tmp';fs.writeFileSync(temp,JSON.stringify({path:saved,runId:job.runId||job.id}),{mode:0o600});fs.renameSync(temp,pointer);rawReport.historyPreserved=true;}catch(error){rawReport.status='BLOCKED';rawReport.historyError=error.message;} }
  const inspection=JSON.parse(await docker(['inspect','--format','{"network":{{json .HostConfig.NetworkMode}},"readonlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"user":{{json .Config.User}},"memory":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"mounts":{{json .Mounts}}}',name]));fs.writeFileSync(path.join(work,'isolation.json'),JSON.stringify({...inspection,image,mounts:inspection.mounts.map(({Destination,RW})=>({Destination,RW})),realModelKeyMounted:false},null,2));
  return report;
 }catch(error){fs.appendFileSync(log,'\nController failure: '+redact(error.stack||error.message).slice(0,4000)+'\n');throw error;}finally{
  await command('docker',['rm','-f',name],{env,cwd:work,log,maxLogBytes:67108864});
  if(relayCreated){await command('docker',['stop','-t','5',relay],{env,cwd:work,log,maxLogBytes:67108864});const stats=await command('docker',['logs',relay],{env,cwd:work});fs.writeFileSync(path.join(work,'model-relay.log'),stats.output,{mode:0o600});await command('docker',['rm','-f',relay],{env,cwd:work,log,maxLogBytes:67108864});}
  if(networkCreated)await command('docker',['network','rm',network],{env,cwd:work,log,maxLogBytes:67108864});
  if(fs.existsSync(tokenFile))fs.unlinkSync(tokenFile);
  if(fs.existsSync(relayKeyFile))fs.unlinkSync(relayKeyFile);
  await workspace?.release({retain:!exported});
  if(laneLock&&fs.existsSync(laneLock))fs.unlinkSync(laneLock);
  if(executorLock&&fs.existsSync(executorLock))fs.unlinkSync(executorLock);
 }
}
