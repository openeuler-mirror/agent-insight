import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {projectCoreWorkbenchTaskStates,activeCoreWorkbenchCancellations} from '../src/lib/storage-core/workbench-results';
function load(file:string,deps:Record<string,unknown>){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>deps[id]??{},console,JSON,Buffer,structuredClone,AbortController,AbortSignal,Date,setTimeout,clearTimeout});return module.exports as Record<string,Function>;}
function clientFixture(){
 let old=0;let created:string|null=null;const calls:Array<{action:string;payload:Record<string,unknown>}>=[];const actor={username:'alice',workspace:'w',principal:'p'};
 let row:Record<string,unknown>={id:'existing-case',input:'original',caseValuesJson:'{}'};
 const context={actor,operationKey:'request',rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});if(action==='read')return {experiment:{id:'exp',cases:[row]}};if(action==='case_upsert'){row={...row,...payload.case as object};return {case_id:row.id,experiment:{id:'exp',cases:[row]}};}throw Error(action);}};
 const prisma=new Proxy({},{get(){old++;throw Error('Legacy Experiment or Trace storage touched');}});
 const api=load('src/lib/skill-workbench/client-execution.ts',{
  '@/lib/storage/prisma':{prisma},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},'node:crypto':{createHash},
  '@/lib/engine/experiment/trace-generation':{TraceGenerationError:class extends Error{},generateExperimentTraces:async(input:Record<string,unknown>,options:Record<string,unknown>)=>{assert.equal(options.forceNewTrace,true);assert.equal(input.user,'alice');row={...row,taskId:'new-trace',executionId:'new-execution',actualOutput:'actual client output'};return {readyCaseIds:[row.id],failedCaseIds:[]};}},
  './execution-target':{validateSkillExecutionTarget:async()=>{}},'@/lib/engine/experiment/cancellation-context':{assertExperimentActive:async()=>{}},
  '@/lib/engine/experiment/dataset-case-binding':{withExperimentDatasetCaseBinding:(value:object,binding:object)=>({...value,__agentInsightDatasetCase:binding})},
 });
 const input={user:'alice',experimentId:'exp',experimentCaseId:'existing-case',datasetCaseId:'dataset-case',datasetId:'dataset',executionTarget:{workerId:'client',platform:'opencode',agent:'build',model:'m'},skill:{name:'skill',version:2,files:{'SKILL.md':'# Skill'}},query:'public query',referenceOutput:'private gold',timeoutMs:30000,signal:new AbortController().signal,onCaseCreated:async(id:string)=>{created=id;}};
 return {api,input,context,calls,get old(){return old;},get created(){return created;}};
}
test('workbench client execution preserves the original result and records its Case only through the core domain',async()=>{
 const fixture=clientFixture();const result=await fixture.api.executeSkillCaseOnClient(fixture.input);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{sessionId:'new-trace',output:'actual client output',experimentCaseId:'existing-case'});assert.equal(fixture.created,'existing-case');assert.equal(fixture.old,0);
 const write=fixture.calls.find(call=>call.action==='case_upsert');assert.ok(write);assert.equal((write.payload.case as {id:string}).id,'existing-case');assert.deepEqual(JSON.parse((write.payload.case as {caseValuesJson:string}).caseValuesJson).__agentInsightDatasetCase,{datasetId:'dataset',caseId:'dataset-case'});
});
test('workbench execution rejects a caller username that differs from the verified core actor',async()=>{
 const fixture=clientFixture();await assert.rejects(fixture.api.executeSkillCaseOnClient({...fixture.input,user:'bob'}),(error:unknown)=>(error as {status:number}).status===403);assert.equal(fixture.old,0);assert.equal(fixture.calls.length,0);
});

test('workbench experiment list reads the authorized complete core view while retaining independent Task metadata',async()=>{
 let old=0;const snapshot={id:'experiment',user:'core-alice',name:'Original Skill experiment',skillName:'skill',skillVersion:1,preset:'use-case',status:'done',configSnapshotJson:JSON.stringify({datasetId:'dataset',caseIds:['case'],traceSource:'generate',grayscaleTaskId:'task'}),skillContextJson:'{}',_count:{cases:1}};
 const view={experiment:{findMany:async()=>[snapshot]},experimentCancellation:{findMany:async()=>[]}};
 const store={skill:{findFirst:async()=>({versions:[{id:'version',version:1}]})},grayscaleTask:{findMany:async()=>[{id:'task',configJson:'{}',caseStatesJson:'{"case":{"b":{"score":80}}}'}]},experiment:new Proxy({},{get(){old++;throw Error('Legacy Experiment read');}}),experimentCancellation:new Proxy({},{get(){old++;throw Error('Legacy cancellation read');}})};
 const api=load('src/lib/skill-workbench/experiment-service.ts',{'@/lib/storage/prisma':{prismaRaw:store},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/workbench':{workbenchReadSource:async()=>view},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>({actor:{username:'alice'},rpc:async()=>({experiment:{id:'experiment',status:'draft',cases:[],cancellations:[]}})})},'@/lib/storage-core/workbench-results':{projectCoreWorkbenchTaskStates,activeCoreWorkbenchCancellations},'./verification-evidence':{readArchivedCoreVerificationIds:async()=>[]},'@/server/agent_datasets_storage':{readAgentDatasetReferences:async()=>[]},'@/lib/evaluators/preset-evaluators':{DEFAULT_SELECTED_PRESET_IDS:['preset']}});
 const result=await api.listWorkbenchExperiments('alice','skill',1);assert.equal(result.experiments[0].id,'experiment');assert.equal(result.experiments[0].caseCount,1);assert.equal(result.experiments[0].grayscaleTask.id,'task');assert.equal(old,0);
});

test('workbench same-config clone preserves the sealed execution config without fetching editable assets',async()=>{
 let old=0;let created:Record<string,unknown>|undefined;
 const source={id:'source',name:'source',scope:'skill-workbench',preset:'use-case',skillName:'skill',skillVersion:1,type:'single',agentName:'build',evaluatorIdsJson:'["judge"]',evaluatorConfigsJson:'{"frozen":true}',configSnapshotJson:JSON.stringify({datasetId:'dataset',caseIds:['case'],grayscaleTaskId:'source-task',versionAId:'__NONE__',versionBId:'v1',boundSide:'b',coreAssets:{releases:{dataset:'release-v1'}},coreWorkbenchTask:{skillId:'skill',skillName:'skill',skillVersion:1,skillVersionId:'v1'},coreWorkbenchExecution:{skillId:'skill',versionAId:'__NONE__',versionBId:'v1',executionTarget:{workerId:'old-client',model:'old-model'},skillSnapshots:{a:null,b:{files:{'SKILL.md':'original'}}}}}),cases:[]};
 const api=load('src/lib/skill-workbench/experiment-service.ts',{'@/lib/storage/prisma':{prismaRaw:new Proxy({},{get(){old++;throw Error('Editable assets or old Experiment must not be read');}})},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/workbench':{requireWorkbenchActor:()=>({actor:{username:'alice'},rpc:async()=>({experiment:source})})},'@/lib/storage-core/workbench-handoff':{resumeCoreWorkbenchHandoff:async()=>null,createCoreWorkbenchHandoff:async(_user:string,input:Record<string,unknown>)=>{created=input;return {experiment:{id:'copy',evaluatorIdsJson:'["judge"]'},grayscaleTask:{id:'copy-task'},configSnapshot:{caseIds:['case']}};}},'@/lib/engine/experiment/experiment-name':{defaultSkillExperimentName:()=> 'copy'}});
 const result=await api.cloneWorkbenchExperimentFromFrozenConfig('alice','source');assert.equal(result.id,'copy');assert.equal(old,0);assert.equal(created?.frozen,true);assert.equal((created?.taskConfig as Record<string,unknown>).executionTarget&&((created?.taskConfig as Record<string,unknown>).executionTarget as {workerId:string}).workerId,'old-client');assert.equal((created?.experiment as {sourceExperimentId:string}).sourceExperimentId,'source');assert.equal((created?.snapshot as {coreAssets:{releases:{dataset:string}}}).coreAssets.releases.dataset,'release-v1');
});

test('workbench read composition delegates only independent owner-scoped control reads and rejects their writes',async()=>{
 const requests:Record<string,unknown>[]=[];const context={actor:{username:'alice'},readView:{experiment:{findFirst:async()=>({id:'core'})}}};
 const api=load('src/lib/storage-core/workbench.ts',{'next/server':{NextRequest:Request},'./mode':{isStorageCoreEnabled:()=>true},'./experiments':{requireCoreExperimentContext:()=>context,ensureCoreExperimentReadView:async()=>{}},'@/lib/storage/prisma':{prismaRaw:{grayscaleTask:{findFirst:async(query:Record<string,unknown>)=>{requests.push(query);return {id:'task'};}}}}});
 assert.equal(typeof api.workbenchControlReadSource,'function');const view=await api.workbenchControlReadSource('alice','experiment');assert.equal((await view.experiment.findFirst()).id,'core');await view.grayscaleTask.findFirst({where:{id:'task',user:'bob'}});assert.equal((requests[0].where as {AND:Array<{user:string}>}).AND.at(-1)?.user,'alice');await assert.rejects(view.grayscaleTask.update({where:{id:'task'},data:{}}),(error:unknown)=>(error as {status:number}).status===503);
});

test('core cancellation activity accepts a planned logical Dataset Case and rejects its tombstone',async()=>{
 let removed=false;const context={rpc:async()=>({experiment:{scope:'skill-workbench',status:'draft',configSnapshotJson:'{"caseIds":["logical"]}',cases:[],cancellations:removed?[{caseKey:'dataset:logical'}]:[]}})};
 const {AsyncLocalStorage}=await import('node:async_hooks');const api=load('src/lib/engine/experiment/cancellation-context.ts',{'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},'@/lib/storage-core/workbench-results':{activeCoreWorkbenchCancellations},'node:async_hooks':{AsyncLocalStorage},'node:crypto':{randomUUID:()=> 'id'},'./evaluation-attempt':{evaluationAttemptSignal:()=>undefined}});
 await api.assertExperimentActive('exp','dataset:logical');removed=true;await assert.rejects(api.assertExperimentActive('exp','dataset:logical'),(e:unknown)=>(e as {status:number}).status===409);await assert.rejects(api.assertExperimentActive('exp','dataset:forged'));
});

test('trigger Case preparation uses core receipts and never resurrects a removed logical Case',async()=>{
 const calls:Array<{action:string;payload:Record<string,unknown>}>=[];const context={actor:{username:'alice',workspace:'w',principal:'p'},operationKey:'op',rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});if(action==='read')return {experiment:{status:'draft',cases:[],cancellations:[{caseKey:'dataset:removed'}]}};if(action==='case_upsert_many')return {case_ids:(payload.cases as Array<{id:string}>).map(row=>row.id)};throw Error(action);}};
 const api=load('src/lib/skill-workbench/trigger-execution.ts',{'@/lib/storage/prisma':{prismaRaw:new Proxy({},{get(){throw Error('Legacy Case write');}})},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/workbench':{requireWorkbenchActor:()=>context},'@/lib/storage-core/workbench-results':{activeCoreWorkbenchCancellations},'node:crypto':{createHash},'@/lib/engine/experiment/dataset-case-binding':{readExperimentDatasetCaseBinding:(value:{__agentInsightDatasetCase:unknown})=>value.__agentInsightDatasetCase,withExperimentDatasetCaseBinding:(v:object,b:object)=>({...v,__agentInsightDatasetCase:b})}});
 const result=await api.ensureTriggerExperimentCases('alice','exp','dataset',[{id:'active',input:'q',values:{should_trigger:true}},{id:'removed',input:'q'}]);assert.equal(result.size,1);assert.ok(result.get('active'));const saved=calls.find(c=>c.action==='case_upsert_many')!;assert.equal((saved.payload.cases as unknown[]).length,1);assert.equal(JSON.parse((saved.payload.cases as Array<{caseValuesJson:string}>)[0].caseValuesJson).should_trigger,true);
});

test('Task visibility authorizes its linked core Experiment before showing independent control data',async()=>{
 let foreign=false;const context={actor:{username:'alice'},rpc:async()=>({gold_redacted:foreign,experiment:{id:'exp',status:'draft',cases:[],deletedAt:null,cancellations:[{caseKey:'dataset:removed'}]}})};
 const api=load('src/lib/engine/experiment/task-visibility.ts',{'@/lib/storage/prisma':{prisma:new Proxy({},{get(){throw Error('Old Experiment read');}})},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},'@/lib/storage-core/workbench-results':{projectCoreWorkbenchTaskStates,activeCoreWorkbenchCancellations}});
 const task={user:'alice',configJson:{evalExperimentId:'core'},caseStatesJson:{active:{},removed:{}}};const visible=await api.visibleExperimentTask(task);assert.deepEqual(Object.keys(visible.caseStatesJson),['active']);foreign=true;await assert.rejects(api.visibleExperimentTask(task),(e:unknown)=>(e as {status:number}).status===403);
});

test('a resumed Workbench create completes signed control links without reloading mutable assets or overwriting a later source',async()=>{
 const events:string[]=[];let prior=false;const expected={id:'record',status:'pending_retest',sourceExperimentId:null,sourceRefsJson:'[]',candidateContentHash:'hash',candidateFilesJson:'{}'};
 const resumed={experiment:{id:'created',name:'created',skillName:'skill',skillVersion:1,preset:'use-case'},grayscaleTask:{id:'task'},configSnapshot:{coreWorkbenchLinks:{sessionId:'session',record:expected}}};
 const store={skillWorkbenchSession:{findFirst:async()=>({id:'session'})},skillOptimizationRecord:{findFirst:async()=>({sourceExperimentId:prior?'newer':null,sourceRefsJson:prior?'[{"type":"experiment","id":"created"}]':'[]'}),updateMany:async({where}:{where:Record<string,unknown>})=>{events.push('record');assert.equal(where.sourceRefsJson,'[]');assert.equal(where.sourceExperimentId,null);return {count:1};}}};
 const api=load('src/lib/skill-workbench/experiment-service.ts',{'@/lib/storage/prisma':{prismaRaw:store},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/workbench':{requireWorkbenchActor:()=>({})},'@/lib/storage-core/workbench-handoff':{resumeCoreWorkbenchHandoff:async()=>resumed},'./task-service':{createOrReuseSkillWorkbenchTask:async()=>events.push('task')}});
 const input={user:'alice',skillName:'skill',version:1,preset:'use-case',datasetId:'dataset'};assert.equal((await api.createWorkbenchExperiment(input)).experiment.id,'created');assert.deepEqual(events,['record','task']);prior=true;events.length=0;await api.createWorkbenchExperiment(input);assert.deepEqual(events,['task']);
});

test('Workbench execution reads its sealed Dataset release despite a newer editable Dataset and never poisons the draft cache',async()=>{
 let latest=0;const calls:Record<string,unknown>[]=[];const context={actor:{username:'alice'},rpc:async()=>({experiment:{scope:'skill-workbench',configSnapshotJson:'{"datasetId":"dataset","coreAssets":{"releases":{"dataset":"release-original"}}}'}})};
 const api=load('src/lib/storage-core/workbench.ts',{'next/server':{NextRequest:Request},'./mode':{isStorageCoreEnabled:()=>true},'./experiments':{requireCoreExperimentContext:()=>context},'@/server/agent_datasets_storage':{findAgentDataset:async()=>{latest++;return {id:'dataset',cases:[{input:'changed'}]};}},'./datasets':{coreDatasetRequest:async(_action:string,body:Record<string,unknown>)=>{calls.push(body);return {release_id:'release-original',dataset:{id:'dataset',cases:[{input:'original'}]}};}}});
 const dataset=await api.readWorkbenchFrozenDataset('alice','experiment','dataset');assert.equal(dataset.cases[0].input,'original');assert.equal(latest,0);assert.equal(calls[0].version,'release-original');
});
test('revoked frozen Dataset access never falls back to latest input or legacy data',async()=>{
 let latest=0;const context={actor:{username:'alice'},rpc:async()=>({experiment:{scope:'skill-workbench',configSnapshotJson:'{"datasetId":"dataset","coreAssets":{"releases":{"dataset":"release-original"}}}'}})};
 const api=load('src/lib/storage-core/workbench.ts',{'next/server':{NextRequest:Request},'./mode':{isStorageCoreEnabled:()=>true},'./experiments':{requireCoreExperimentContext:()=>context},'@/server/agent_datasets_storage':{findAgentDataset:async()=>{latest++;}},'./datasets':{coreDatasetRequest:async()=>{throw Object.assign(new Error('revoked'),{status:403});}}});
 await assert.rejects(api.readWorkbenchFrozenDataset('alice','experiment','dataset'),(e:unknown)=>(e as {status:number}).status===403);assert.equal(latest,0);
});
