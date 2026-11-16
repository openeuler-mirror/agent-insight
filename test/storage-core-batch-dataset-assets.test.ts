import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
test('one typed Dataset read freezes every selected dataset release with its own private cases',async()=>{
 const rows=[{id:'a',cases:[{id:'one',input:'first',expectedOutput:'gold-a'}]},{id:'b',cases:[{id:'two',input:'second',expectedOutput:'gold-b'}]}];const snapshots=new Map();let scopes=0;
 const sandboxModule={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage-core/experiment-assets.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>({
  'node:crypto':{createHash},'@/lib/evaluators/preset-evaluators':{presetEvaluators:[]},'./evaluators':{runWithCoreEvaluatorActor:(_actor:unknown,fn:()=>Promise<unknown>)=>fn(),freezeCoreEvaluators:async()=>({releases:[],cards:{}})},
  './datasets':{runWithCoreDatasetActor:async(_actor:unknown,_req:unknown,fn:()=>Promise<unknown>)=>{scopes++;return fn();},requireCoreDatasetContext:()=>({snapshots})},
  '@/server/agent_datasets_storage':{findAgentDataset:async(_user:string,id:string)=>{const row=rows.find(row=>row.id===id);if(row)snapshots.set(id,{dataset:row,release_id:'release-'+id});return row||null;}},
 }[name]||{}),JSON,Map,Set,structuredClone});
 const api=sandboxModule.exports as {freezeExperimentAssets:(c:unknown,v:unknown)=>Promise<{configSnapshotJson:string}>};
 const result=await api.freezeExperimentAssets({actor:{username:'alice'},request:{},options:{}},{evaluatorIdsJson:'[]',configSnapshotJson:JSON.stringify({datasetIds:['a','deleted','b']})});
 const value=JSON.parse(result.configSnapshotJson);assert.equal(value.coreAssets.releases['dataset:a'],'release-a');assert.equal(value.coreAssets.releases['dataset:b'],'release-b');assert.equal(value.coreBatchDatasets.datasets[1].cases[0].expectedOutput,'gold-b');assert.equal(scopes,1);
 rows[0].cases[0].input='later edit';assert.equal(value.coreBatchDatasets.datasets[0].cases[0].input,'first');
});
