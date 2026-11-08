import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { traceBaselineFiles } from './trace-only-contract.mjs';

const script=new URL('./fixtures/trace_root_ssh.py',import.meta.url).pathname;
const input=path.resolve('public/example/messages');
test('004 fixed script returns four actual log facts and original evidence without modifying input',()=>{
 const hash=()=>createHash('sha256').update(fs.readFileSync(input)).digest('hex'),before=hash();
 const result=spawnSync(process.env.E2E_PYTHON||'/opt/homebrew/bin/python3',[script,input],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout);assert.deepEqual({...output,evidence:undefined},{total_lines:2000,root_ssh_failures:351,top_source:'150.183.249.110',top_source_failures:80,evidence:undefined});
 assert.ok(output.evidence.length>0);for(const line of output.evidence){assert.ok(fs.readFileSync(input,'utf8').includes(line));assert.ok(line.includes('authentication failure;')&&line.includes('user=root'));}
 assert.equal(hash(),before);
});

test('004 baseline explains real nonzero stderr handling before optimization',()=>{
 const baseline=traceBaselineFiles('e2e-trace');assert.match(baseline['SKILL.md'],/非\s*0[\s\S]*stderr[\s\S]*停止[\s\S]*Step 2/);
});
test('004 script preserves Unicode facts on ASCII stdout',()=>{
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR||'/tmp','e2e-004-encoding-'));
 try {
  const input=path.join(directory,'messages');const line='Jul 10 sshd(pam_unix): authentication failure; rhost=测试主机 user=root';fs.writeFileSync(input,line+'\n');
  const result=spawnSync(process.env.E2E_PYTHON||'/opt/homebrew/bin/python3',[script,input],{encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'ascii'}});
  assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.top_source,'测试主机');assert.deepEqual(data.evidence,[line]);assert.equal(fs.readFileSync(input,'utf8'),line+'\n');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('004 fixture rejects absent root evidence and unreadable input with actionable errors, never synthetic results',()=>{
 const directory=fs.mkdtempSync(path.join(process.env.TMPDIR||'/tmp','e2e-004-negative-'));
 try{
  const file=path.join(directory,'no-root.log');fs.writeFileSync(file,'ordinary event\n');
  const empty=spawnSync(process.env.E2E_PYTHON||'/opt/homebrew/bin/python3',[script,file],{encoding:'utf8'});
  assert.equal(empty.status,4);assert.equal(empty.stdout,'');assert.match(empty.stderr,/no root authentication failure/i);assert.match(empty.stderr,/verify/i);assert.equal(fs.readFileSync(file,'utf8'),'ordinary event\n');
  const missing=spawnSync(process.env.E2E_PYTHON||'/opt/homebrew/bin/python3',[script,path.join(directory,'absent')],{encoding:'utf8'});assert.equal(missing.status,3);assert.equal(missing.stdout,'');assert.match(missing.stderr,/check.*path.*read/i);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
