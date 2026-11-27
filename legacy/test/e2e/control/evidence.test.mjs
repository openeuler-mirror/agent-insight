import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectEvidence, saveEvidence } from './evidence.mjs';
test('evidence survives transport without secrets, databases or symlink targets',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-evidence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=path.join(root,'pr-abc-002');fs.mkdirSync(path.join(run,'private'),{recursive:true});
 fs.writeFileSync(path.join(run,'trace.png'),'pixels');fs.writeFileSync(path.join(run,'private','startup.log'),'failure detail');
 fs.writeFileSync(path.join(run,'private','fault-run.json'),'{"status":"failed"}');fs.writeFileSync(path.join(run,'private','account.json'),'secret');fs.writeFileSync(path.join(run,'private','data.db'),'database');
 fs.symlinkSync(path.join(run,'private','account.json'),path.join(run,'leaked.png'));
 const evidence=collectEvidence(root,'pr-abc');assert.equal(evidence.files.length,3);
 const out=path.join(root,'out');saveEvidence(out,evidence);
 assert.equal(fs.readFileSync(path.join(out,'pr-abc-002/private/startup.log'),'utf8'),'failure detail');
 assert.throws(()=>saveEvidence(path.join(root,'evil'),{files:[{path:'../escape',data:'eA=='}]}),/path/);
});
test('oversized evidence is recorded as omitted instead of exhausting output',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-evidence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'pr-abc'));fs.writeFileSync(path.join(root,'pr-abc','trace.png'),Buffer.alloc(100));
 const result=collectEvidence(root,'pr-abc',{maxFileBytes:50});assert.equal(result.files.length,0);assert.equal(result.omitted.length,1);
});
