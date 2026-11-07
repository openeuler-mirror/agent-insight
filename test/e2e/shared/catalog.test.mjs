import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {caseDirectory} from './catalog.mjs';import {loadExecutionConfig} from './config.mjs';import {executeSuite} from './suite.mjs';
test('005 runs fault recovery while the merged dataset scenario stays removed',()=>{
 assert.equal(caseDirectory('005'),'005-fault-recovery');assert.equal(fs.existsSync(new URL('../cases/005-dataset-evaluation',import.meta.url)),false);assert.equal(caseDirectory('003'),'003-skill-lifecycle');
});
test('trusted configuration rejects the old 006 number',()=>{assert.throws(()=>loadExecutionConfig({overrides:{cases:['006']}}),/case|scenario|006/i);});
test('suite rejects the old 006 number before invoking a runner',async()=>{let calls=0;await assert.rejects(()=>executeSuite({mode:'mock',selected:['006'],runMockCase:()=>{calls++}}),/case|scenario|006/i);assert.equal(calls,0);});
