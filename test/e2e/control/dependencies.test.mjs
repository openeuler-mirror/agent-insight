import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {prepareDependencies} from './dependencies.mjs';
test('only Prisma writable packages are copied; large dependencies stay in the image',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-deps-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=path.join(root,'image'),target=path.join(root,'work');
 for(const name of ['.prisma','@prisma','prisma','.bin','next']){fs.mkdirSync(path.join(source,name),{recursive:true});fs.writeFileSync(path.join(source,name,'file'),'original');}
 fs.mkdirSync(target);fs.symlinkSync(path.join(source,'next'),path.join(target,'next'),'dir');prepareDependencies(source,target);assert.ok(!fs.lstatSync(path.join(target,'.prisma')).isSymbolicLink());assert.ok(fs.lstatSync(path.join(target,'next')).isSymbolicLink());fs.writeFileSync(path.join(target,'.prisma/file'),'changed');assert.equal(fs.readFileSync(path.join(source,'.prisma/file'),'utf8'),'original');
});
