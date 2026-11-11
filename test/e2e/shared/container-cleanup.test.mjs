import test from 'node:test';import assert from 'node:assert/strict';import {orphanTargets,cleanupContainerOrphans} from './container-cleanup.mjs';
test('container orphan cleanup preserves controller and suite while collecting detached descendants',()=>{
 assert.deepEqual(orphanTargets([{pid:1,parent:0},{pid:7,parent:1},{pid:15,parent:7},{pid:30,parent:1},{pid:31,parent:30}],[1,7,15]),[30,31]);
});
test('ordinary local execution never sweeps global processes',async()=>{
 const before=process.env.E2E_ISOLATED_CONTAINER;delete process.env.E2E_ISOLATED_CONTAINER;try{assert.deepEqual(await cleanupContainerOrphans(),{stopped:0});}finally{if(before!==undefined)process.env.E2E_ISOLATED_CONTAINER=before;}
});
test('AtomGit Job leaves the platform worker processes alone', async () => {
 const isolated=process.env.E2E_ISOLATED_CONTAINER;
 const job=process.env.E2E_ATOMGIT_JOB;
 process.env.E2E_ISOLATED_CONTAINER='1';
 process.env.E2E_ATOMGIT_JOB='1';
 try{assert.deepEqual(await cleanupContainerOrphans(),{stopped:0});}
 finally{
  if(isolated===undefined)delete process.env.E2E_ISOLATED_CONTAINER;else process.env.E2E_ISOLATED_CONTAINER=isolated;
  if(job===undefined)delete process.env.E2E_ATOMGIT_JOB;else process.env.E2E_ATOMGIT_JOB=job;
 }
});
