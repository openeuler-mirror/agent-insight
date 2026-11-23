import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createActionsProcessScope} from './actions-process-cleanup.mjs';

const linux={skip:process.platform!=='linux'};
const inspectable=pid=>{try{fs.readFileSync(`/proc/${pid}/environ`);return true;}catch(error){if(error.code==='EACCES'||error.code==='EPERM')return false;throw error;}};
const running=pid=>{try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]!=='Z';}catch{return false;}};
async function waitFor(read,accept,timeout=5000){const until=Date.now()+timeout;while(Date.now()<until){const value=read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Process fixture deadline exceeded');}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'actions-process-scope-')),groups=new Set();
  t.after(()=>{for(const pid of groups)try{process.kill(-pid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});});
  const start=async(env,{orphan=false,exitCode,shutdownSpawn=false,nondumpable=false}={})=>{
    const file=path.join(root,'ready-'+groups.size+'.json'),childReady=file+'.child';
    const sleeper="process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);";
    const launch=`spawn(process.execPath,['-e',${JSON.stringify(sleeper)},${JSON.stringify(childReady)}],{env:process.env,detached:true,stdio:'ignore'})`;
    const code=`const fs=require('fs');const {spawn}=require('child_process');let child;${orphan?`child=${launch};child.unref();`:''}${shutdownSpawn?`process.on('SIGTERM',()=>{child=${launch};child.unref();fs.writeFileSync(process.argv[1],JSON.stringify({root:process.pid,child:child.pid}));process.exit(0);});`:"process.on('SIGTERM',()=>{});"}fs.writeFileSync(process.argv[1],JSON.stringify({root:process.pid,child:child?.pid}));${exitCode===undefined?'setInterval(()=>{},1000);':`process.exit(${exitCode});`}`;
    const opaque="import ctypes,json,os,signal,sys,time; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; signal.signal(signal.SIGTERM,signal.SIG_IGN); open(sys.argv[1],'w').write(json.dumps({'root':os.getpid()})); time.sleep(60)";
    const child=spawn(nondumpable?'python3':process.execPath,nondumpable?['-I','-c',opaque,file]:['-e',code,file],{cwd:root,env:{PATH:process.env.PATH,E2E_SUITE_RUN_ID:'same-run-id',...env},detached:true,stdio:'ignore'});groups.add(child.pid);
    const closed=once(child,'close');
    const data=await waitFor(()=>{try{return JSON.parse(fs.readFileSync(file));}catch{return null;}},Boolean);if(data.child){groups.add(data.child);await waitFor(()=>fs.existsSync(childReady),Boolean);}
    return {child,closed,file,data,recordSpawned:()=>{const data=JSON.parse(fs.readFileSync(file));if(data.child)groups.add(data.child);return data;}};
  };
  return {start,groups};
}

test('scopes are unique, private, do not mutate controller env, and cleanup is idempotent',linux,async()=>{
  const before=process.env.E2E_ACTIONS_PROCESS_SCOPE,a=await createActionsProcessScope(),b=await createActionsProcessScope();
  assert.match(a.env.E2E_ACTIONS_PROCESS_SCOPE,/^[a-f0-9]{64}$/);assert.notEqual(a.env.E2E_ACTIONS_PROCESS_SCOPE,b.env.E2E_ACTIONS_PROCESS_SCOPE);
  assert.equal(process.env.E2E_ACTIONS_PROCESS_SCOPE,before);
  const [first,again]=await Promise.all([a.cleanup(),a.cleanup()]);assert.deepEqual(first,{status:'PASS',stopped:0,remaining:0});assert.deepEqual(again,first);
  assert.ok(!JSON.stringify(first).includes(a.env.E2E_ACTIONS_PROCESS_SCOPE));assert.deepEqual(await b.cleanup(),{status:'PASS',stopped:0,remaining:0});
});

test('a SIGKILLed parent cannot leave its detached owned grandchild or kill unrelated Workers',linux,async t=>{
  const f=fixture(t),scope=await createActionsProcessScope(),other=await createActionsProcessScope();
  const worker=await f.start({}),otherWorker=await f.start(other.env),prefixWorker=await f.start({E2E_ACTIONS_PROCESS_SCOPE:scope.env.E2E_ACTIONS_PROCESS_SCOPE+'-suffix'});
  const owned=await f.start(scope.env,{orphan:true});owned.child.kill('SIGKILL');await owned.closed;assert.equal(running(owned.data.child),true);
  const cleaned=await scope.cleanup();assert.equal(cleaned.status,'PASS');assert.ok(cleaned.stopped>=1);assert.equal(cleaned.remaining,0);
  await waitFor(()=>running(owned.data.child),value=>!value);
  assert.equal(running(worker.child.pid),true);assert.equal(running(otherWorker.child.pid),true);assert.equal(running(prefixWorker.child.pid),true);
  assert.equal(running(process.pid),true);await other.cleanup();
});

for(const exitCode of [0,1])test(`cleanup reclaims detached descendants after parent exit ${exitCode}`,linux,async t=>{
  const f=fixture(t),scope=await createActionsProcessScope(),owned=await f.start(scope.env,{orphan:true,exitCode});
  const [code]=await owned.closed;assert.equal(code,exitCode);assert.equal(running(owned.data.child),true);
  const result=await scope.cleanup();assert.ok(result.stopped>=1);assert.equal(result.remaining,0);await waitFor(()=>running(owned.data.child),value=>!value);
});

test('cleanup rescans a detached descendant spawned while its parent handles SIGTERM',linux,async t=>{
  const f=fixture(t),scope=await createActionsProcessScope(),owned=await f.start(scope.env,{shutdownSpawn:true});
  try{const result=await scope.cleanup();const data=owned.recordSpawned();assert.ok(data.child);assert.ok(result.stopped>=2);assert.equal(result.remaining,0);await waitFor(()=>running(data.child),value=>!value);}
  finally{owned.recordSpawned();}
});

test('an unavailable helper fails preflight instead of issuing an unverified scope',linux,async()=>{
  await assert.rejects(createActionsProcessScope({python:'/nonexistent-actions-cleanup-python'}),/cleanup helper could not start/);
});

test('the helper protects its marked controller ancestor from its own cleanup scope',linux,async t=>{
  const scope=await createActionsProcessScope(),helper=new URL('./actions-process-cleanup.py',import.meta.url).pathname;
  const script="const {spawnSync}=require('child_process');const run=payload=>spawnSync('python3',['-I',process.argv[1]],{env:{PATH:process.env.PATH},input:JSON.stringify(payload),encoding:'utf8'});const checked=run({operation:'check'});if(checked.status!==0)process.exit(1);const baseline=JSON.parse(checked.stdout).baseline.filter(row=>row[0]!==process.pid);const result=run({operation:'cleanup',token:process.env.E2E_ACTIONS_PROCESS_SCOPE,baseline});if(result.status!==0)process.exit(1);process.stdout.write(result.stdout);";
  const child=spawn(process.execPath,['-e',script,helper],{env:{PATH:process.env.PATH,...scope.env},detached:true,stdio:['ignore','pipe','ignore']});
  t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
  let output='';child.stdout.on('data',data=>{output+=data;});const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
  try{const [code,signal]=await once(child,'close');assert.equal(code,0);assert.equal(signal,null);assert.deepEqual(JSON.parse(output),{status:'PASS',stopped:0,remaining:0});}
  finally{clearTimeout(timer);}
});


test('a new nondumpable owned process is stopped or blocks cleanup when its identity is unreadable',linux,async t=>{
  const f=fixture(t),scope=await createActionsProcessScope(),owned=await f.start(scope.env,{nondumpable:true});
  const readable=inspectable(owned.child.pid),results=await Promise.allSettled([scope.cleanup(),scope.cleanup()]);
  if(readable){assert.ok(results.every(result=>result.status==='fulfilled'));assert.equal(results[0].value.remaining,0);await waitFor(()=>running(owned.child.pid),value=>!value);}
  else{assert.ok(results.every(result=>result.status==='rejected'));for(const result of results)assert.ok(!result.reason.message.includes(scope.env.E2E_ACTIONS_PROCESS_SCOPE));assert.equal(running(owned.child.pid),true);}
});

test('a nondumpable preexisting Worker remains untouched and does not block an empty scope',linux,async t=>{
  const f=fixture(t),worker=await f.start({},{nondumpable:true});
  const scope=await createActionsProcessScope();assert.deepEqual(await scope.cleanup(),{status:'PASS',stopped:0,remaining:0});
  assert.equal(running(worker.child.pid),true);
});

test('a reused baseline PID with a different start time cannot hide a nondumpable process',linux,async t=>{
  const f=fixture(t),scope=await createActionsProcessScope(),owned=await f.start(scope.env,{nondumpable:true});
  const readable=inspectable(owned.child.pid),helper=new URL('./actions-process-cleanup.py',import.meta.url).pathname;
  const request=async payload=>{const child=spawn('python3',['-I',helper],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','ignore']});let output='';child.stdout.on('data',data=>{output+=data;});child.stdin.end(JSON.stringify(payload));const [code]=await once(child,'close');return {code,output,result:JSON.parse(output)};};
  const checked=await request({operation:'check'});assert.equal(checked.code,0);
  const baseline=checked.result.baseline.map(row=>row[0]===owned.child.pid?[row[0],'0']:row);
  const {code,output,result}=await request({operation:'cleanup',token:scope.env.E2E_ACTIONS_PROCESS_SCOPE,baseline});
  if(readable){assert.equal(code,0);assert.equal(result.status,'PASS');assert.ok(result.stopped>=1);await waitFor(()=>running(owned.child.pid),value=>!value);}
  else{assert.equal(code,1);assert.equal(result.status,'BLOCKED');assert.ok(result.remaining>0);assert.equal(running(owned.child.pid),true);}
  assert.ok(!output.includes(scope.env.E2E_ACTIONS_PROCESS_SCOPE));
});
