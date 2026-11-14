import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

async function helpers(){
 assert.ok(fs.existsSync('src/lib/agent-dataset-concurrency.ts'),'per-snapshot Dataset concurrency helper is required');
 return import('../src/lib/agent-dataset-concurrency');
}
function componentFunction(file:string,name:string,context:Record<string,unknown>){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let code='';const visit=(node:ts.Node)=>{
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===name&&node.initializer)code=node.initializer.getText(source);
  if(ts.isFunctionDeclaration(node)&&node.name?.text===name)code=node.getText(source);
  ts.forEachChild(node,visit);
 };visit(source);assert.ok(code,`${name} must exist`);
 const output=ts.transpileModule(`const action=${code};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return vm.runInNewContext(output+'\naction',{...context});
}
test('each editor retains its own strong ETag instead of following another successful write',async()=>{
 const {datasetWriteHeaders,captureDatasetSnapshot}=await helpers();
 const first=captureDatasetSnapshot({id:'d',cases:[]},new Headers({etag:'"v1"'}));
 const second=captureDatasetSnapshot({...first},new Headers({etag:'"v1"'}));
 const saved=captureDatasetSnapshot({id:'d',cases:['new']},new Headers({etag:'"v2"'}));
 assert.deepEqual(datasetWriteHeaders(first),{'If-Match':'"v1"'});
 assert.deepEqual(datasetWriteHeaders(second),{'If-Match':'"v1"'});
 assert.deepEqual(datasetWriteHeaders(saved),{'If-Match':'"v2"'});
 assert.deepEqual(datasetWriteHeaders({}),{});
});
test('mixed item, full case and field snapshots refuse to bless stale input with a newer version',async()=>{
 const {datasetWriteHeaders,captureDatasetSnapshot}=await helpers();
 assert.throws(()=>datasetWriteHeaders({_storageEtag:'"v1"'},{_storageEtag:'"v2"'}));
 assert.throws(()=>captureDatasetSnapshot({_storageEtag:'"v1"'},new Headers({etag:'"v2"'})));
 for(const etag of ['*','W/"v1"','unquoted','"a\nb"'])assert.throws(()=>datasetWriteHeaders({_storageEtag:etag}));
 assert.deepEqual(datasetWriteHeaders({_storageEtag:'"v1"'},{_storageEtag:'"v1"'}),{'If-Match':'"v1"'});
});
test('Dataset center draft preserves the detail version through edits and emits it on PATCH',async()=>{
 const helpersApi=await helpers();let seen:RequestInit|undefined;let error='';
 const draft={id:'d',name:'draft',description:'',tagsText:'',datasetKind:'ideal_output',fields:[],cases:[],_storageEtag:'"v1"'};
 const action=componentFunction('src/components/AgentDatasetCenter.tsx','handleSave',{
  user:'alice',draft,creating:false,...helpersApi,parseTags:()=>[],setSaving:()=>{},setError:(message:string)=>{error=message;},
  apiFetch:async(_url:string,options:RequestInit)=>{seen=options;return Response.json({error:'conflict'},{status:409});},
 });await action();assert.equal(new Headers((seen as RequestInit | undefined)?.headers).get('if-match'),'"v1"');assert.equal(error,'conflict');
 const toDraft=componentFunction('src/components/AgentDatasetCenter.tsx','toDraft',{coerceDatasetKind:(kind:string)=>kind});
 assert.equal(toDraft(draft)._storageEtag,'"v1"');
});

test('case and field saves use their editing snapshot and reject mismatched full-case sources before HTTP',async()=>{
 const helpersApi=await helpers();let seen:RequestInit|undefined;let message='';
 const old={id:'d',_storageEtag:'"v1"',fields:[],cases:[],datasetKind:'ideal_output'};
 const latest={...old,_storageEtag:'"v2"'};
 const base={dataset:latest,user:'alice',isReadOnly:false,...helpersApi,setSaving:()=>{},setError:(value:string)=>{message=value;},setFieldError:()=>{},
  fieldText:()=>'',withEvaluatorCatalogFields:(fields:unknown)=>fields,
  apiFetch:async(_url:string,options:RequestInit)=>{seen=options;return Response.json({error:'conflict'},{status:409});},
 };
 const cases=componentFunction('src/components/DatasetItemsPage.tsx','persistCases',base);
 assert.equal(await cases([],old,old),false);assert.equal(new Headers((seen as RequestInit | undefined)?.headers).get('if-match'),'"v1"');
 seen=undefined;message='';assert.equal(await cases([],old,latest),false);assert.equal(seen,undefined);assert.ok(message);
 const fields=componentFunction('src/components/DatasetItemsPage.tsx','persistFields',base);
 assert.equal(await fields([],old),false);assert.equal(new Headers((seen as RequestInit | undefined)?.headers).get('if-match'),'"v1"');
});
test('row and field editors capture versions when opened rather than after another save',async()=>{
 const helpersApi=await helpers();const dataset={id:'d',_storageEtag:'"v1"',fields:[],cases:[]};let rowEditor:Record<string,unknown>|null=null;
 const fieldEditorSnapshot:{current:unknown}={current:null};
 const base={dataset,isReadOnly:false,...helpersApi,createEmptyCase:()=>({id:'c'}),setRowEditor:(value:Record<string,unknown>)=>{rowEditor=value;},fieldEditorSnapshot,setFieldDraft:()=>{},setFieldError:()=>{},setFieldEditorOpen:()=>{}};
 componentFunction('src/components/DatasetItemsPage.tsx','openAdd',base)();
 assert.equal((rowEditor as unknown as {snapshot:unknown}).snapshot,dataset);
 componentFunction('src/components/DatasetItemsPage.tsx','openFieldEditor',base)();assert.equal(fieldEditorSnapshot.current,dataset);
});

test('row, deletion and batch operations carry every source snapshot to the final case write',async()=>{
 const old={id:'d',_storageEtag:'"v1"',fields:[],cases:[],datasetKind:'ideal_output'};
 const full={...old,cases:[{id:'old'}]};const seen:unknown[][]=[];
 const base={dataset:old,user:'alice',saving:false,isReadOnly:false,setError:()=>{},setSaving:()=>{},
  loadFullDataset:async()=>full,persistCases:async(...args:unknown[])=>{seen.push(args);return true;},
 };
 await componentFunction('src/components/DatasetItemsPage.tsx','removeRow',base)('old');
 assert.equal(seen[0][1],old);assert.equal(seen[0][2],full);
 const rowEditor={mode:'add',row:{id:'new',values:{}},snapshot:old,_storageEtag:old._storageEtag};
 await componentFunction('src/components/DatasetItemsPage.tsx','saveRowFromModal',{
  ...base,rowEditor,hasMeaningfulDatasetCaseValue:()=>true,
 })();assert.equal(seen[1][1],old);assert.equal(seen[1][2],full);assert.equal(seen[1][3],rowEditor);
 await componentFunction('src/components/DatasetItemsPage.tsx','runBatchImport',{
  ...base,dataset:{...old,_storageEtag:'"v2"'},batchSnapshot:{current:old},batchImportMethod:'paste',batchPasteText:'[]',
  setBatchModalError:()=>{},parseBatchAuto:()=>({cases:[{id:'import'}]}),closeBatchModal:()=>{},
 })();assert.equal(seen[2][1],old);assert.equal(seen[2][2],full);
});
test('delete uses its displayed record version while legacy deletes omit If-Match',async()=>{
 const {datasetWriteHeaders}=await helpers();let seen:RequestInit|undefined;
 const action=componentFunction('src/components/AgentDatasetCenter.tsx','handleDeleteDataset',{
  user:'alice',isBuiltinReliabilityDataset:()=>false,globalThis:{confirm:()=>true},setTableActionError:()=>{},setDeletingId:()=>{},datasetWriteHeaders,
  apiFetch:async(_url:string,options:RequestInit)=>{seen=options;return Response.json({error:'conflict'},{status:409});},
 });
 await action({id:'d',name:'dataset',_storageEtag:'"v1"'});assert.equal(new Headers((seen as RequestInit | undefined)?.headers).get('if-match'),'"v1"');
 await action({id:'legacy',name:'legacy'});assert.equal(new Headers((seen as RequestInit | undefined)?.headers).get('if-match'),null);
});

test('failed Dataset summary reads keep existing rows and show the existing error state',async()=>{
 let assignments=0;let error='';
 const load=componentFunction('src/components/AgentDatasetCenter.tsx','loadDatasets',{
  useCallback:(action:unknown)=>action,user:'alice',setRefreshing:()=>{},setLoading:()=>{},
  setError:(message:string)=>{error=message;},setDatasets:()=>{assignments++;},setCreating:()=>{},
  apiFetch:async()=>Response.json({error:'Dataset storage request failed'},{status:503}),
 });
 await load();assert.equal(assignments,0);assert.equal(error,'Dataset storage request failed');
});
