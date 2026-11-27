import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { saveHarnessBody } from '../src/lib/ingest/deepseek-harness-otel/body-store';

const moduleUrl = pathToFileURL(path.resolve('scripts/agent-trace-collectors/deepseek-harness/process-lock.mjs')).href;
const pluginUrl = pathToFileURL(path.resolve('scripts/agent-trace-collectors/deepseek-harness/index.js')).href;
async function abandoned(file: string) {
  const script = `import {acquireProcessLock} from ${JSON.stringify(moduleUrl)}; if(!acquireProcessLock(process.argv[1])) process.exit(2); console.log('held'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [data] = await once(child.stdout, 'data'); assert.match(String(data), /held/);
  const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  return owner;
}

test('SIGKILL recovery is used by member, queue and platform body admission', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recover-'));
  const p = await import(pluginUrl);
  try {
    const member = path.join(root, createHash('sha256').update('s').digest('hex') + '.lock');
    await abandoned(member);
    assert.equal(p.persistRequestMember(root, { sourceSessionId: 's', attemptId: 'one', expiresAt: new Date(Date.now()+60000).toISOString(), items: [] }), 'stored');
    await abandoned(path.join(root, '.admission.lock'));
    assert.equal(p.admitTelemetry(root, { resourceLogs: [] }), 'stored');
    await abandoned(path.join(root, '.write.lock'));
    const id = randomUUID();
    assert.equal(saveHarnessBody('alice', { sourceSessionId:'s', attemptId:id, expiresAt:new Date(Date.now()+60000).toISOString(), items:[{text:'API381'}] },root), id);
    assert.equal(fs.readdirSync(root).some(file => /lock|candidate|retired/.test(file)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Aged live, foreign, malformed and recovery-claim locks remain fail closed', async () => {
  const { acquireProcessLock } = await import(moduleUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recover-safe-')), file = path.join(dir, '.lock');
  try {
    const release = acquireProcessLock(file); assert.ok(release);
    fs.utimesSync(file, new Date(0), new Date(0)); assert.equal(acquireProcessLock(file), null); release();
    for (const text of ['unknown legacy owner', JSON.stringify({version:1,pid:process.pid,host:'different-host',platform:process.platform,token:'foreign'})]) {
      fs.writeFileSync(file,text); assert.equal(acquireProcessLock(file),null); assert.equal(fs.readFileSync(file,'utf8'),text); fs.unlinkSync(file);
    }
    fs.writeFileSync(file+'.recovery','crashed recovery must be inspected');
    assert.equal(acquireProcessLock(file),null); assert.ok(fs.existsSync(file+'.recovery'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Concurrent orphan recoverers cannot enter the protected section together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recover-race-')), file = path.join(dir,'.lock');
  try {
    await abandoned(file);
    const code = `import fs from 'node:fs';import {acquireProcessLock} from ${JSON.stringify(moduleUrl)};const release=acquireProcessLock(process.argv[1]);if(release){const marker=process.argv[1]+'.critical';const fd=fs.openSync(marker,'wx');await new Promise(r=>setTimeout(r,150));fs.closeSync(fd);fs.unlinkSync(marker);release();console.log('acquired')}else console.log('busy');`;
    const results = await Promise.all(Array.from({length:8},()=>new Promise<string>((resolve,reject)=>{
      const c=spawn(process.execPath,['--input-type=module','-e',code,file]);let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.on('error',reject);c.on('close',n=>n===0?resolve(out.trim()):reject(new Error(err)));
    })));
    assert.ok(results.includes('acquired')); assert.ok(results.every(x=>['busy','acquired'].includes(x)));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('A release callback cannot remove a different owner token', async () => {
  const {acquireProcessLock}=await import(moduleUrl);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-token-')),file=path.join(dir,'.lock');
  try { const release=acquireProcessLock(file);const owner=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...owner,token:randomUUID()}));release();assert.ok(fs.existsSync(file)); }
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('A SIGKILL during recovery can itself be recovered without stealing a live recovery claim', async () => {
 const {acquireProcessLock}=await import(moduleUrl);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-recover-interrupt-')),file=path.join(dir,'.lock');
 try {
  await abandoned(file);await abandoned(file+'.recovery');
  const release=acquireProcessLock(file);assert.ok(release);release();
  assert.equal(fs.readdirSync(dir).length,0);
  const releaseClaim=acquireProcessLock(file+'.recovery');assert.ok(releaseClaim);assert.equal(acquireProcessLock(file),null);releaseClaim();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Unknown ownership records are bounded, diagnosed and preserved across all admission paths', async () => {
 const {acquireProcessLock,inspectProcessLock}=await import(moduleUrl),p=await import(pluginUrl);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-unknown-')),file=path.join(dir,'.lock');
 try {
  for(const text of ['','123','null','[]','{',JSON.stringify({version:1,host:os.hostname(),platform:process.platform,pid:2147483647,token:''}),'x'.repeat(4097)]){
   fs.writeFileSync(file,text);fs.utimesSync(file,new Date(0),new Date(0));
   assert.equal(acquireProcessLock(file),null);assert.equal(inspectProcessLock(file).state,'blocked-unknown');assert.equal(fs.readFileSync(file,'utf8'),text);fs.unlinkSync(file);
  }
  const paths=[path.join(dir,'.admission.lock'),path.join(dir,'.write.lock'),path.join(dir,createHash('sha256').update('s').digest('hex')+'.lock')];
  for(const f of paths)fs.writeFileSync(f,'legacy owner cannot be established');
  assert.equal(p.admitTelemetry(dir,{}),'busy');
  assert.equal(p.persistRequestMember(dir,{sourceSessionId:'s',attemptId:'x'}),'busy');
  assert.throws(()=>saveHarnessBody('alice',{sourceSessionId:'s',attemptId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),items:[{text:'body'}]},dir),/busy/);
  assert.ok(paths.every(f=>fs.readFileSync(f,'utf8')==='legacy owner cannot be established'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Unverifiable PID permission and excessive recovery nesting never permit a takeover',async()=>{
 const {acquireProcessLock,inspectProcessLock}=await import(moduleUrl),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-unverifiable-')),file=path.join(dir,'.lock');
 const originalKill=process.kill;
 try {
  const owner=await abandoned(file);process.kill=(()=>{throw Object.assign(new Error('not permitted'),{code:'EPERM'})}) as any;
  assert.equal(acquireProcessLock(file),null);assert.equal(inspectProcessLock(file).state,'held-or-unverifiable');assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),owner);
  process.kill=originalKill;
  for(let i=1;i<=8;i++)fs.writeFileSync(file+'.recovery'.repeat(i),JSON.stringify(owner));
  const before=fs.readdirSync(dir).map(f=>[f,fs.readFileSync(path.join(dir,f),'utf8')]);
  assert.equal(acquireProcessLock(file),null);assert.deepEqual(fs.readdirSync(dir).map(f=>[f,fs.readFileSync(path.join(dir,f),'utf8')]),before);
 }finally{process.kill=originalKill;fs.rmSync(dir,{recursive:true,force:true});}
});

test('A symbolic-link lock never changes its target', {skip:process.platform==='win32'?'Symlink permission varies on Windows; covered on Linux':false}, async()=>{
 const {acquireProcessLock,inspectProcessLock}=await import(moduleUrl),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-link-')),target=path.join(dir,'target'),file=path.join(dir,'.lock');
 try {fs.writeFileSync(target,'DO_NOT_TOUCH');fs.symlinkSync(target,file);assert.equal(acquireProcessLock(file),null);assert.equal(inspectProcessLock(file).reason,'not-regular-file');assert.equal(fs.readFileSync(target,'utf8'),'DO_NOT_TOUCH');assert.ok(fs.lstatSync(file).isSymbolicLink());}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
