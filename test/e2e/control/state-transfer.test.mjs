import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {collectState,saveState} from './state-transfer.mjs';
test('state transport preserves only this lane app with strict size and symlink limits',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'pr/app/data'),{recursive:true});fs.mkdirSync(path.join(root,'daily/app'),{recursive:true});fs.writeFileSync(path.join(root,'pr/app/data/trace'),'body');fs.writeFileSync(path.join(root,'daily/app/secret'),'other lane');
 fs.mkdirSync(path.join(root,'pr/app/fault-injection/runtimes'),{recursive:true});fs.symlinkSync('/usr/bin/python3',path.join(root,'pr/app/fault-injection/runtimes/python'));
 const state=collectState(root,'pr');assert.equal(state.files.length,1);const out=path.join(root,'out');saveState(out,state,'pr');assert.equal(fs.readFileSync(path.join(out,'pr/app/data/trace'),'utf8'),'body');assert.throws(()=>collectState(root,'pr',{maxBytes:1}),/quota/);fs.symlinkSync('/tmp',path.join(root,'pr/app/link'));assert.throws(()=>collectState(root,'pr'),/symbolic/);
});
import {DatabaseSync} from 'node:sqlite';import {verifyHistory} from './state-transfer.mjs';
test('previous trace content cannot silently disappear or change during a new run',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const build=(name,content)=>{const home=path.join(root,name);fs.mkdirSync(path.join(home,'pr/app/data'),{recursive:true});const db=new DatabaseSync(path.join(home,'pr/app/data/witty_insight.db'));db.exec('CREATE TABLE Session (taskId TEXT,user TEXT,interactions TEXT); CREATE TABLE Execution (id TEXT,taskId TEXT,user TEXT,query TEXT,finalResult TEXT,agentName TEXT)');db.prepare('INSERT INTO Execution VALUES(?,?,?,?,?,?)').run('e1','old','test_e2e_pr@example.com','question','answer','build');db.prepare('INSERT INTO Session VALUES(?,?,?)').run('old','test_e2e_pr@example.com',content);db.close();return home;};
 const old=build('old','kept');assert.doesNotThrow(()=>verifyHistory(old,build('same','kept'),'pr'));assert.throws(()=>verifyHistory(old,build('changed','mutated'),'pr'),/Historical/);
 const missing=build('missing','kept'),db=new DatabaseSync(path.join(missing,'pr/app/data/witty_insight.db'));db.exec('DELETE FROM Execution');db.close();assert.throws(()=>verifyHistory(old,missing,'pr'),/Historical/);
});
test('state keeps native runtime sessions but excludes reinstallable OpenCode dependency cache',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-runtime-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const runtime=path.join(root,'pr/app/data/.opencode-runtime/user/opencode');fs.mkdirSync(path.join(runtime,'node_modules/.bin'),{recursive:true});fs.symlinkSync('/opt/bin/tool',path.join(runtime,'node_modules/.bin/tool'));fs.writeFileSync(path.join(runtime,'session.json'),'native evidence');
 const state=collectState(root,'pr');assert.deepEqual(state.files.map(f=>f.path),['pr/app/data/.opencode-runtime/user/opencode/session.json']);
});
test('state identity mismatch is rejected before history filtering can hide another account',async t=>{
 const {assertStateAccount}=await import('./state-transfer.mjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-account-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const home=path.join(root,'pr/app/data');fs.mkdirSync(home,{recursive:true});const db=new DatabaseSync(path.join(home,'witty_insight.db'));db.exec('CREATE TABLE Execution (user TEXT)');db.prepare('INSERT INTO Execution VALUES(?)').run('test_original@example.com');db.close();assert.doesNotThrow(()=>assertStateAccount(root,'pr','test_original@example.com'));assert.throws(()=>assertStateAccount(root,'pr','test_changed@example.com'),/account/);
});
