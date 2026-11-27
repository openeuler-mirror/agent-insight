import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {command} from './runtime.mjs';

test('deadline gives the child a chance to clean its resources before forced termination',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-timeout-'));const marker=path.join(dir,'cleaned');
 try{
  const source="const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[1],'cleaned');process.exit(143)});setInterval(()=>{},1000)";
  const result=await command(process.execPath,['-e',source,marker],{timeout:250});
  assert.equal(result.expired,true);assert.equal(fs.readFileSync(marker,'utf8'),'cleaned');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('bounded logs drain child output and retain its final result',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const log=path.join(dir,'log');
 const result=await command(process.execPath,['-e',"process.stdout.write('x'.repeat(100000));process.stdout.write('FINAL');"],{log,maxLogBytes:1024,maxOutputChars:100});
 assert.equal(result.code,0);assert.ok(result.output.endsWith('FINAL'));assert.ok(fs.statSync(log).size<1200);assert.match(fs.readFileSync(log,'utf8'),/LOG TRUNCATED/);
});
test('supervisor can allow a trusted worker to finish cleanup beyond the default 1.5 seconds',async t=>{
 const {stopCommands}=await import('./runtime.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-worker-stop-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const ready=path.join(dir,'ready'),cleaned=path.join(dir,'cleaned');
 const running=command(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(process.argv[2],'done');process.exit(0)},1700));fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)",ready,cleaned]);
 while(!fs.existsSync(ready))await new Promise(r=>setTimeout(r,20));
 await stopCommands({graceMs:3000});const result=await running;assert.equal(result.code,0);assert.equal(fs.readFileSync(cleaned,'utf8'),'done');
});
