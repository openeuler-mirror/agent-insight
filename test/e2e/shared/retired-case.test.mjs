import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {caseDirectory} from './catalog.mjs';import {loadExecutionConfig} from './config.mjs';import {executeSuite} from './suite.mjs';
test('005 keeps its report identity but no longer resolves to a runnable scenario',()=>{
 assert.throws(()=>caseDirectory('005'),/merged.*003/i);assert.equal(fs.existsSync(new URL('../cases/005-dataset-evaluation',import.meta.url)),false);assert.equal(caseDirectory('003'),'003-skill-lifecycle');
});
test('trusted configuration cannot schedule retired 005',()=>{assert.throws(()=>loadExecutionConfig({overrides:{cases:['005']}}),/005|merged|retired/i);});
test('suite rejects explicitly requesting retired 005 before invoking a runner',async()=>{let calls=0;await assert.rejects(()=>executeSuite({mode:'mock',selected:['005'],runMockCase:()=>{calls++}}),/005|merged|retired/i);assert.equal(calls,0);});
