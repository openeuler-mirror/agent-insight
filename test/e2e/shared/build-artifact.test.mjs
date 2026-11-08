import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {sourceFingerprint,validateBuildArtifact} from './build-artifact.mjs';
test('source fingerprint covers uncommitted and new source but ignores ignored runtime output',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-fingerprint-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));spawnSync('git',['init','-q'],{cwd:root});fs.writeFileSync(path.join(root,'.gitignore'),'runtime\n');fs.writeFileSync(path.join(root,'code'),'a');const a=sourceFingerprint(root);fs.writeFileSync(path.join(root,'runtime'),'ignored');assert.equal(sourceFingerprint(root),a);fs.writeFileSync(path.join(root,'code'),'b');assert.notEqual(sourceFingerprint(root),a);const b=sourceFingerprint(root);fs.writeFileSync(path.join(root,'new'),'source');assert.notEqual(sourceFingerprint(root),b);
});
test('runtime refuses a different source, incomplete build or wrong BUILD_ID',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'compiled-build-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({status:'PASS',sourceFingerprint:'one',buildId:'build'}));assert.throws(()=>validateBuildArtifact(root,'two'),/fingerprint/);assert.throws(()=>validateBuildArtifact(root,'one'),/missing/);
 for(const file of ['.next/BUILD_ID','.next/standalone/server.js','.next/standalone/.next/required-server-files.json','.next/static']){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),file.endsWith('BUILD_ID')?'wrong':'');}assert.throws(()=>validateBuildArtifact(root,'one'),/BUILD_ID/);
});
test('compiled manifest remains readable by the sandbox user under restrictive controller umask',async t=>{
 const {writeBuildManifest}=await import('./build-artifact.mjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-permissions-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const previous=process.umask(0o077);
 try{const directory=path.join(root,'compiled');writeBuildManifest(directory,{status:'PASS'});assert.equal(fs.statSync(directory).mode&0o777,0o755);assert.equal(fs.statSync(path.join(directory,'manifest.json')).mode&0o777,0o644);}finally{process.umask(previous);}
});
