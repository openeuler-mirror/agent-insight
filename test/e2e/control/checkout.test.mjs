import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCheckout } from './checkout.mjs';

test('checkout merges the exact head and base with both parent histories',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-merge-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'source');fs.mkdirSync(source);
 const env={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1'};
 const command=async(bin,args,cwd)=>{const r=spawnSync(bin,args,{cwd,env,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();};
 const git=args=>command('git',['-c','user.name=E2E','-c','user.email=e2e@example.invalid','-c','commit.gpgsign=false',...args],source);
 await git(['init','-q']);fs.writeFileSync(path.join(source,'common'),'base');await git(['add','.']);await git(['commit','-qm','base']);const ancestor=await git(['rev-parse','HEAD']);
 fs.writeFileSync(path.join(source,'head'),'PR content');await git(['add','.']);await git(['commit','-qm','head']);const headSha=await git(['rev-parse','HEAD']);
 await git(['checkout','--detach',ancestor]);fs.writeFileSync(path.join(source,'target'),'target content');await git(['add','.']);await git(['commit','-qm','target']);const baseSha=await git(['rev-parse','HEAD']);
 const checkout=path.join(root,'checkout');const job={repository:'owner/repo',sourceRepository:'owner/repo',headSha,baseSha};
 const sha=await prepareCheckout(job,checkout,command,()=>source);
 const parents=await command('git',['rev-list','--parents','-n','1',sha],checkout);
 assert.deepEqual(parents.split(' '),[sha,baseSha,headSha]);
 assert.equal(fs.readFileSync(path.join(checkout,'head'),'utf8'),'PR content');assert.equal(fs.readFileSync(path.join(checkout,'target'),'utf8'),'target content');
 assert.equal(fs.existsSync(path.join(checkout,'.git/shallow')),false);
});
