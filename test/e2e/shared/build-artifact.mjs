import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
export function sourceFingerprint(project){
 const listed=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:project,encoding:'utf8'});assert.equal(listed.status,0,'Cannot enumerate source');
 const hash=createHash('sha256');
 for(const file of [...new Set(listed.stdout.split('\0').filter(Boolean))].sort()){
  const full=path.join(project,file);if(!fs.existsSync(full))continue;
  assert.ok(!fs.lstatSync(full).isSymbolicLink(),'Source symlink is not allowed in build fingerprint');
  hash.update(file+'\0');hash.update(fs.readFileSync(full));hash.update('\0');
 }
 return hash.digest('hex');
}
export function validateBuildArtifact(directory,fingerprint){
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
 assert.equal(manifest.status,'PASS');assert.equal(manifest.sourceFingerprint,fingerprint,'Compiled source fingerprint mismatch');
 for(const file of ['.next/BUILD_ID','.next/standalone/server.js','.next/standalone/.next/required-server-files.json','.next/static'])assert.ok(fs.existsSync(path.join(directory,file)),'Compiled artifact missing: '+file);
 assert.equal(fs.readFileSync(path.join(directory,'.next/BUILD_ID'),'utf8').trim(),manifest.buildId,'Compiled BUILD_ID mismatch');return manifest;
}
export function writeBuildManifest(directory,result){
 fs.mkdirSync(directory,{recursive:true,mode:0o755});fs.chmodSync(directory,0o755);const file=path.join(directory,'manifest.json');fs.writeFileSync(file,JSON.stringify(result),{mode:0o644});fs.chmodSync(file,0o644);
}
