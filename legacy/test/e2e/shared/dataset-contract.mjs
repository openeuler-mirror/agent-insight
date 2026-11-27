import assert from 'node:assert/strict';
import {stableHash} from './skill-archive.mjs';
export function datasetBusinessHash(d){return stableHash({id:d.id,name:d.name,datasetKind:d.datasetKind,cases:d.cases.map(c=>({id:c.id,input:c.input,expectedOutput:c.expectedOutput}))});}
export function assertConstructedDataset(d,recipe,name,user,owner){assert.ok(d.id);assert.equal(d.name,name);assert.equal(d.datasetKind,'ideal_output');assert.equal(d.user??owner,user);assert.equal(d.cases.length,1);assert.ok(d.cases[0].id);assert.equal(d.cases[0].input,recipe.input);assert.equal(d.cases[0].expectedOutput,recipe.reference);return {case:d.cases[0],datasetHash:datasetBusinessHash(d)};}
