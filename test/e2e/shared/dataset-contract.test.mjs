import test from 'node:test';import assert from 'node:assert/strict';
import {assertConstructedDataset,datasetBusinessHash} from './dataset-contract.mjs';
test('UI dataset preserves one exact input/reference and private ownership; derived caches may change',()=>{
 const recipe={input:'统计指定离线日志的root失败及首要来源，引用实际证据。',reference:'root 失败351次，首要来源150.183.249.110，共80次。'},d={id:'dataset',name:'test-dataset',datasetKind:'ideal_output',cases:[{id:'case',input:recipe.input,expectedOutput:recipe.reference}]};
 assert.doesNotThrow(()=>assertConstructedDataset(d,recipe,d.name,'owner','owner'));for(const change of [v=>v.cases[0].input='changed',v=>v.cases[0].expectedOutput='easier',v=>v.cases.push({...v.cases[0],id:'second'})]){const altered=structuredClone(d);change(altered);assert.throws(()=>assertConstructedDataset(altered,recipe,d.name,'owner','owner'));}assert.throws(()=>assertConstructedDataset(d,recipe,d.name,'owner','foreign'));
 const cached=structuredClone(d);cached.cases[0].rootCauses=[{content:'derived'}];assert.equal(datasetBusinessHash(cached),datasetBusinessHash(d));cached.cases[0].input='different';assert.notEqual(datasetBusinessHash(cached),datasetBusinessHash(d));
});
