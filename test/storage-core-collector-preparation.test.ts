import assert from 'node:assert/strict';
import test from 'node:test';
import {isolateTestDatabase} from './helpers/isolated-test-db';
isolateTestDatabase('collector-preparation');
import * as service from '../src/lib/storage/data-service';

type Api = typeof service & {prepareExecutionRecordState:(input:any)=>any;prepareExecutionSession:(input:any)=>any;prepareTraceThread:(input:any)=>any;prepareSubagentExecutions:(input:any)=>any};
const api=service as Api;
const at='2026-11-16T12:00:00.000Z';

test('shared source preparation preserves canonical identity, query and version zero while replacing a complete Pi snapshot',()=>{
 assert.equal(typeof api.prepareExecutionRecordState,'function');
 const old={id:'canonical',taskId:'task',query:'original query',framework:'pi-agent',skill:'s',skillVersion:0,timestamp:new Date(at),clientId:'first'};
 const oldMessages=[{role:'user',content:'old'},{role:'assistant',content:'old answer'}];
 const data={task_id:'task',upload_id:'new',framework:'pi-agent',query:'new query',skill_version:2,clientId:'new',interactions:[{role:'user',content:'small',extension:{zero:0,nil:null}}],session_merge_strategy:'snapshot-replace'};
 const before=JSON.stringify({old,data,oldMessages});
 const prepared=api.prepareExecutionRecordState({data,recordId:'canonical',existingExecution:old,existingSession:{interactions:JSON.stringify(oldMessages)},defaultTimestamp:at,allowSnapshotShrink:true});
 assert.equal(prepared.targetRecord.upload_id,'canonical');assert.equal(prepared.targetRecord.query,'original query');assert.equal(prepared.targetRecord.skill_version,0);assert.equal(prepared.targetRecord.clientId,'first');
 assert.deepEqual(prepared.mergedInteractionsForSession,data.interactions);assert.equal(prepared.skipped,false);assert.equal(JSON.stringify({old,data,oldMessages}),before);
});

test('shared source preparation applies explicit label rewrite and query override and retains monotonic messages',()=>{
 const prepared=api.prepareExecutionRecordState({data:{task_id:'task',framework:'opencode',query:' new query ',force_query_update:true,label:'rewrite-v0',skill_version:8,interactions:[{id:'later',role:'user',content:'later'}]},recordId:'task',existingExecution:{id:'task',taskId:'task',framework:'opencode',query:'old',skillVersion:2},existingSession:{interactions:JSON.stringify([{id:'first',role:'user',content:'first'}])},defaultTimestamp:at,allowSnapshotShrink:false});
 assert.equal(prepared.targetRecord.query,'new query');assert.equal(prepared.targetRecord.skill,'rewrite');assert.equal(prepared.targetRecord.skill_version,0);assert.equal(prepared.explicitSkillVersionRewrite,true);assert.equal(prepared.mergedInteractionsForSession!.length,2);
});

test('shared source preparation distinguishes missing interactions from empty and retains disallowed shrink',()=>{
 const base={recordId:'task',defaultTimestamp:at,allowSnapshotShrink:false};
 assert.equal(api.prepareExecutionRecordState({...base,data:{task_id:'task',framework:null}}).mergedInteractionsForSession,null);
 assert.deepEqual(api.prepareExecutionRecordState({...base,data:{task_id:'task',interactions:[]}}).mergedInteractionsForSession,[]);
 const p=api.prepareExecutionRecordState({...base,data:{task_id:'task',framework:'jiuwenswarm',session_merge_strategy:'snapshot-replace',interactions:[]},existingSession:{interactions:'[{"role":"user","content":"kept"}]'}});assert.equal(p.skipped,true);
});

test('shared Session preparation preserves completion-first end time and uses the sealed default clock',()=>{
 assert.equal(typeof api.prepareExecutionSession,'function');
 const p=api.prepareExecutionSession({record:{task_id:'task',framework:'opencode',query:'query'},interactions:[],existingSession:{taskId:'task',startTime:at,endTime:'2026-11-16T12:10:00.000Z',label:'opencode'},defaultTimestamp:'2026-11-17T01:00:00.000Z'});
 assert.equal(p.session.startTime,at);assert.equal(p.session.endTime,'2026-11-16T12:10:00.000Z');
 const absent=api.prepareExecutionSession({record:{task_id:'task'},interactions:null,defaultTimestamp:at});assert.equal(absent.session,null);
 const empty=api.prepareExecutionSession({record:{task_id:'task'},interactions:[],defaultTimestamp:at});assert.equal(empty.session.startTime,at);assert.deepEqual(empty.session.interactions,[]);
});

test('shared Thread preparation retains scoped event identity and explicit source-turn links without writes',()=>{
 assert.equal(typeof api.prepareTraceThread,'function');
 const p:any=api.prepareTraceThread({recordId:'execution',threadId:'thread',data:{task_id:'task',framework:'codex',user:'alice',sourceExecutionId:'turn1',traceThread:{sourceThreadId:'source',metadata:{zero:0},events:[{eventKey:'event',kind:'execution_transition',startedAt:at,sourceTurnId:'turn1',relatedSourceTurnId:'turn2',payload:{zero:0}},{eventKey:'invalid',kind:'input_steer',startedAt:'invalid'}]}}});
 assert.equal(p.thread.id,'thread');assert.equal(p.events.length,1);assert.equal(p.events[0].executionId,'execution');assert.equal(p.events[0].eventKey,service.scopeTraceThreadEventKey('alice','codex','source','event'));assert.deepEqual(JSON.parse(p.events[0].payloadJson),{zero:0,relatedSourceExecutionId:'turn2'});
});

test('frozen quick source preparation binds revision and trusted provenance without current DB, models or clocks',async()=>{
 const {existsSync}=await import('node:fs');assert.equal(existsSync('src/lib/storage-core/collector-preparation.ts'),true);
 const core=await import('../src/lib/storage-core/collector-preparation');
 const reservation:any={trace_id:'trace',task_id:'task',execution_id:'first',operation_key:'operation',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'7',source_revision:'7',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'task',upload_id:'new',framework:'pi-agent',query:'query',skill:'s',user:'forged',clientId:'forged',interactions:[],tokens:0,cost:0,latency:0},},provenance:{legacy_username:'legacy-alice',verified_client_id:null,framework:'pi-agent'},snapshot:null};
 const frozen:any={version:1,actor:{principal:'alice',workspace:'w',username:'legacy-alice'},binding:{trace_id:'trace',task_id:'task',execution_id:'first',operation_key:'operation',input_hash:'a'.repeat(64),base_revision:'7'},configs:[],skills:[{id:'s',name:'s',activeVersion:0,versions:[{version:0,content:'version zero'}]}],active_skill_versions:{s:0},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:true,execution_match:null,thread_id:null};
 frozen.binding=core.collectorPreparationBinding(reservation);
 const oldNow=Date.now;Date.now=()=>{throw Error('Current clock forbidden');};
 try{
  const value:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);
  assert.equal(value.snapshot.execution.id,'first');assert.equal(value.snapshot.execution.taskId,'task');assert.equal(value.snapshot.execution.user,'legacy-alice');assert.equal(value.snapshot.execution.clientId,null);assert.equal(value.snapshot.execution.skillVersion,0);assert.equal(value.snapshot.execution.tokens,0);assert.equal(value.snapshot.session.startTime,at);
  const namedData={...reservation.operation_request.data};delete namedData.skill;
  const named={...reservation,operation_request:{data:{...namedData,interactions:[{role:'assistant',tool_calls:[{id:'skill-prototype',name:'skill',arguments:'{"name":"constructor"}'}]}]}}};
  const namedResult:any=await core.prepareCoreCollectorSnapshot(named,{...frozen,binding:core.collectorPreparationBinding(named),skills:[],active_skill_versions:{}});
  assert.deepEqual(namedResult.root_skills,[{name:'constructor',version:null}]);
  assert.equal(value.binding.base_revision,'7');assert.equal(value.background_analysis,false);assert.equal(JSON.stringify(value).includes('forged'),false);assert.deepEqual(value.children,[]);
  await assert.rejects(core.prepareCoreCollectorSnapshot({...reservation,base_revision:'8'},frozen),(e:any)=>e.status===409);
  await assert.rejects(core.prepareCoreCollectorSnapshot({...reservation,received_at_ms:reservation.received_at_ms+1},frozen),(e:any)=>e.status===409);
  await assert.rejects(core.prepareCoreCollectorSnapshot({...reservation,operation_request:{data:{...reservation.operation_request.data,query:'changed raw input'}}},frozen),(e:any)=>e.status===409);
  await assert.rejects(core.prepareCoreCollectorSnapshot({...reservation,provenance:{...reservation.provenance,legacy_username:'other'}},frozen),(e:any)=>e.status===403);
 }finally{Date.now=oldNow;}
});

test('source preparation matches independent original handler portable snapshots, children and Thread plans',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 const golden=(await import('./fixtures/collector-preparation-golden.json')).default;
 const previous=new Map<string,any>();
 for(const [index,item] of golden.cases.entries()){
  const data=item.input as any;if(item.name.includes('completion-first')||item.name.includes('completion-creates')){if(item.session)previous.set(data.task_id??data.session_id,{execution:null,session:item.session});continue;}
  const expected=item.snapshot as any;if(!expected)continue;
  const task=String(data.task_id||data.upload_id),prior=previous.get(task);
  const reservation:any={trace_id:task,task_id:task,execution_id:prior?.execution?.id??expected.execution.id,operation_key:item.name,operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:String(index),source_revision:String(index),received_at_ms:Date.parse(!data.timestamp ? expected.execution.timestamp : !data.trace_started_at ? (item as any).session_default_clock??at : at),completed_at_ms:prior?.session?.endTime?Date.parse(prior.session.endTime):null,operation_request:{data},provenance:{legacy_username:'collector-golden-owner',verified_client_id:null,framework:data.framework},snapshot:prior?.execution?prior:null};

  const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'collector-golden-owner'},binding:Object.fromEntries(['trace_id','task_id','execution_id','operation_key','input_hash','base_revision'].map(key=>[key,reservation[key]])),configs:[],skills:[{id:'skill',name:'collector-golden-skill',activeVersion:0,versions:[{version:2,content:'v2'},{version:0,content:'v0'}]}],active_skill_versions:{'collector-golden-skill':0},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:service.allowsSnapshotShrinkForFramework(data.framework),execution_match:null,thread_id:(item as any).thread?.id??null};
  if((item as any).configs){
   frozen.configs=(item as any).configs.map((config:any)=>({id:config.id,query:config.query,dataset_type:config.datasetType,skill:config.skill,skillVersion:config.skillVersion,routing_intent:config.routingIntent??undefined,routing_anchors:config.routingAnchors?JSON.parse(config.routingAnchors):undefined,expectedSkills:config.expectedSkills?JSON.parse(config.expectedSkills):undefined,standard_answer:config.standardAnswer,root_causes:config.rootCauses?JSON.parse(config.rootCauses):undefined,key_actions:item.name==='routing-outcome-config-v0'?undefined:config.keyActions?JSON.parse(config.keyActions):undefined}));
   frozen.parsed_flows=(item as any).parsedFlows;frozen.skills[0].id=frozen.parsed_flows[0].skillId;
  }
  frozen.binding=core.collectorPreparationBinding(reservation);frozen.previous_session=prior?.session??null;
  const value:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert(value.snapshot, item.name);
  const expectedShape=(actual:any,shape:any)=>Object.fromEntries(Object.keys(shape).map(key=>[key,actual[key]]));
  assert.deepEqual(expectedShape(value.snapshot.execution,expected.execution),expected.execution,item.name+' execution');
  assert.deepEqual(value.snapshot.session&&expectedShape(value.snapshot.session,expected.session),expected.session,item.name+' session');
  for(const [key,expectedValue] of Object.entries((item as any).expected_fields??{}))assert.deepEqual(value.snapshot.execution[key],expectedValue,item.name+' '+key);
  if(item.name==='routing-outcome-config-v0'){assert.equal(value.record.outcome_evaluation.key_action_count,2);assert.equal(value.post_hooks.filter((hook:any)=>hook.kind==='config_key_actions').length,1);}
  const expectedChildren=item.children as any[];assert.equal(value.children.length,expectedChildren.length,item.name+' child count');
  for(let n=0;n<expectedChildren.length;n++){assert.deepEqual(expectedShape(value.children[n].snapshot.execution,expectedChildren[n].execution),expectedChildren[n].execution,item.name+' child execution');assert.deepEqual(expectedShape(value.children[n].snapshot.session,expectedChildren[n].session),expectedChildren[n].session,item.name+' child session');}
  if((item as any).thread){assert(value.thread);assert.equal(value.thread.thread.sourceThreadId,(item as any).thread.sourceThreadId);assert.equal(value.thread.events[0].eventKey,(item as any).threadEvents[0].eventKey);}
  previous.set(task,value.snapshot);
 }
});

test('source preparation keeps thread-only input as a real Thread plan without inventing an Execution',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 const reservation:any={trace_id:'trace',task_id:'thread-task',execution_id:'thread-task',operation_key:'thread-only',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'thread-task',framework:'codex',threadOnly:true,traceThread:{sourceThreadId:'thread',events:[{eventKey:'event',kind:'interrupt',startedAt:at}]}}},provenance:{legacy_username:'alice',verified_client_id:null,framework:'codex'},snapshot:null};
 const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:Object.fromEntries(['trace_id','task_id','execution_id','operation_key','input_hash','base_revision'].map(key=>[key,reservation[key]])),configs:[],skills:[],active_skill_versions:{},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:false,execution_match:null,thread_id:'thread-id'};
 frozen.binding=core.collectorPreparationBinding(reservation);
 const value:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert.equal(value.snapshot,null);assert.equal(value.disposition,'thread_only');assert(value.thread);assert.equal(value.thread.events[0].executionId,undefined);
});

test('completion preparation retains empty Session/default clock semantics without inventing a Trace fact',async()=>{
 const core:any=await import('../src/lib/storage-core/collector-preparation');assert.equal(typeof core.prepareCoreCollectorCompletion,'function');
 const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:'completion',operation:'complete',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms:Date.parse(at),completed_at_ms:Date.parse('2026-11-17T00:00:00Z'),operation_request:{task_id:'task'},provenance:{legacy_username:'alice'},snapshot:null};
 const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:Object.fromEntries(['trace_id','task_id','execution_id','operation_key','input_hash','base_revision'].map(key=>[key,reservation[key]]))};
 frozen.binding=core.collectorPreparationBinding(reservation);
 const empty=core.prepareCoreCollectorCompletion(reservation,frozen);assert.equal(empty.snapshot,null);assert.equal(empty.session.startTime,at);assert.equal(empty.session.label,'opencode');assert.deepEqual(empty.session.interactions,[]);assert.equal(empty.response.endTime,'2026-11-17T00:00:00.000Z');
 const existingReservation={...reservation,snapshot:{execution:{id:'task',taskId:'task'},session:null}};
 const existing=core.prepareCoreCollectorCompletion(existingReservation,{...frozen,binding:core.collectorPreparationBinding(existingReservation)});assert.equal(existing.snapshot.execution.id,'task');assert.equal(existing.snapshot.session.startTime,at);
 const old={taskId:'task',label:'old label',startTime:'2026-11-15T00:00:00Z',interactions:[{role:'user',content:'real'}]};
 const oldReservation={...reservation,snapshot:{execution:{id:'task',taskId:'task'},session:old}};
 const updated=core.prepareCoreCollectorCompletion(oldReservation,{...frozen,binding:core.collectorPreparationBinding(oldReservation)});assert.equal(updated.session.startTime,old.startTime);assert.equal(updated.session.label,'old label');assert.deepEqual(updated.session.interactions,old.interactions);
});

test('capture selects only related static assets, retains no credentials and performs no old dynamic writes',async()=>{
 const [{readFileSync},vm,ts]=await Promise.all([import('node:fs'),import('node:vm'),import('typescript')]);
 const runtime={exports:{}};let authenticated=0,staticReads=0,flowReads=0,autoEnabled=false;const user='alice';
 const skill={id:'skill-id',name:'related',activeVersion:0,versions:[{version:9,content:'latest version'},{version:0,content:'active version'}]};
 const actor={principal:'p',workspace:'w',username:user,token:'private-actor-token'};
 const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:'capture',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'task',framework:'pi-agent',skill:'related',query:'query',interactions:[]}},provenance:{legacy_username:user},snapshot:null};
 const identity={operation:'snapshot',revalidate:async()=>{authenticated++;}};
 const deps:any={'node:crypto':await import('node:crypto'),'@/lib/storage/data-service':{...service,readConfig:async()=>[],readEvaluationResults:()=>({related:'80'})},'@/lib/storage/prisma':{db:new Proxy({findSkill:async()=>{throw Error('Legacy all-owner Skill reader forbidden');},findParsedFlow:async()=>{flowReads++;throw Error('No matching outcome config: no flow needed');}},{get(target,key){if(key in target)return (target as any)[key];throw Error('Old dynamic DB forbidden '+String(key));}}),prismaRaw:{skill:{findMany:async(args:any)=>{assert.equal(args.where.user,user);assert.equal(args.select.versions,undefined);staticReads++;return [{id:'skill-id',name:'related',activeVersion:0}];}},skillVersion:{findMany:async(args:any)=>{assert.equal(args.where.skillId,'skill-id');return args.select.content?skill.versions.filter(version=>args.where.version.in.includes(version.version)):skill.versions.map(({version})=>({version}));}},registeredAgent:{findMany:async(args:any)=>{assert(Array.isArray(args.where.name?.in),'Unrelated agent scan forbidden');return [];}}}},'@/lib/storage/server-config':{getUserSettings:async()=>({autoEvaluationEnabled:autoEnabled,models:[{apiKey:'private-model-key',baseUrl:'private-endpoint'}]}),getActiveConfig:async()=>({id:'model',provider:'openai',model:'fixture',apiKey:'private-model-key',baseUrl:'https://model.example/v1?credential=private-query',headers:{Authorization:'Bearer private-header'}})},'./frozen-model':await import('../src/lib/storage-core/frozen-model'),'./collector-identity':{isVerifiedCoreCollectorIdentity:(value:unknown)=>value===identity,withCoreCollectorIdentity:async(_identity:unknown,action:any)=>action(actor)}};
 for(const name of ['@/lib/engine/evaluation/label-utils','@/lib/engine/observability/agent-registration','@/lib/fleet/call-stats','@/lib/system-agent-names','@/lib/ingest/opencode-snapshot'])deps[name]=await import(name);
 vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/collector-preparation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:runtime,exports:runtime.exports,require:(name:string)=>{assert(name in deps,name);return deps[name];},console,structuredClone,JSON,Map,Set,Buffer,Date});
 const api=runtime.exports as any;const frozen=await api.captureCoreCollectorPreparation(identity,reservation);
 assert.equal(frozen.actor.username,user);assert.equal(frozen.settings.autoEvaluationEnabled,false);assert.equal(frozen.skills.length,1);assert.equal(frozen.skills[0].name,'related');assert.equal(staticReads,1);assert.equal(flowReads,0);assert.equal(authenticated,1);
 const text=JSON.stringify(frozen);assert.equal(text.includes('private-actor-token'),false);assert.equal(text.includes('private-model-key'),false);assert.equal(text.includes('private-endpoint'),false);
 autoEnabled=true;const enabled=await api.captureCoreCollectorPreparation(identity,reservation);assert.equal(enabled.model_selection.id,'model');assert.equal(enabled.model_selection.baseUrl,'https://model.example/v1');for(const secret of ['private-model-key','private-query','private-header'])assert.equal(JSON.stringify(enabled).includes(secret),false);
 await assert.rejects(api.captureCoreCollectorPreparation({...identity},reservation),(error:any)=>error.status===403);
});

test('legacy shared quick preparation reads the actual scoped Skill active version through its bound adapter',async()=>{
 const {prismaRaw}=await import('../src/lib/storage/prisma');
 const name='collector-preparation-active',user='collector-preparation-owner';
 const skill=await prismaRaw.skill.create({data:{name,user,activeVersion:3,versions:{create:[{version:3,content:'active'},{version:4,content:'latest'}]}}});
 try{
  const {quickData}=await service.prepareUploadQuickData({task_id:'task',framework:'pi-agent',skill:name,interactions:[]},user);
  assert.equal(quickData.skill_version,3);
 }finally{await prismaRaw.skillVersion.deleteMany({where:{skillId:skill.id}});await prismaRaw.skill.delete({where:{id:skill.id}});}
});

test('a rejected smaller snapshot retains the original preceding Thread write plan',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:'small',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'1',source_revision:'1',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'task',framework:'generic',session_merge_strategy:'snapshot-replace',sourceExecutionId:'turn',interactions:[],traceThread:{sourceThreadId:'thread',events:[{eventKey:'event',kind:'interrupt',sourceTurnId:'turn',startedAt:at}]}}},provenance:{legacy_username:'alice'},snapshot:{execution:{id:'task',taskId:'task',framework:'generic',traceThreadId:null},session:{taskId:'task',startTime:at,interactions:[{role:'user',content:'larger'}]}}};
 const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:core.collectorPreparationBinding(reservation),configs:[],skills:[],active_skill_versions:{},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:false,execution_match:null,thread_id:'thread'};
 const value:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert.equal(value.skipped,true);assert(value.thread);assert.equal(value.thread.events[0].eventKey,service.scopeTraceThreadEventKey('alice','generic','thread','event'));assert.deepEqual(value.snapshot,reservation.snapshot);
 assert.equal(value.thread.events[0].executionId,'task');assert.equal(value.snapshot.execution.traceThreadId,null);assert.deepEqual(value.post_hooks,[]);
});

test('legacy saves use a real default timestamp for falsy public JSON timestamps on create and update',async()=>{
 const {prismaRaw}=await import('../src/lib/storage/prisma');
 const user='collector-falsy-timestamps';
 try{
  for(const [index,timestamp] of [null,'',0].entries()){
   const task='collector-falsy-'+index;const started=Date.now();
   await service.saveExecutionRecord({task_id:task,framework:'pi-agent',user,query:'before',timestamp,skip_evaluation:true} as any);
   const created=await prismaRaw.execution.findUniqueOrThrow({where:{id:task}});
   assert(created.timestamp.getTime()>=started&&created.timestamp.getTime()<=Date.now());
   const updatedAfter=Date.now();
   await service.saveExecutionRecord({task_id:task,framework:'pi-agent',user,query:'after',force_query_update:true,timestamp,skip_evaluation:true} as any);
   const updated=await prismaRaw.execution.findUniqueOrThrow({where:{id:task}});
   assert.equal(updated.query,'after');assert(updated.timestamp.getTime()>=updatedAfter&&updated.timestamp.getTime()<=Date.now());
  }
  await assert.rejects(service.saveExecutionRecord({task_id:'collector-genuinely-invalid-time',framework:'pi-agent',user,query:'invalid new input',timestamp:'not-a-date',skip_evaluation:true}),(error:any)=>error.name==='PrismaClientValidationError');
  assert.equal(await prismaRaw.execution.findUnique({where:{id:'collector-genuinely-invalid-time'}}),null);
 }finally{await prismaRaw.execution.deleteMany({where:{user}});await prismaRaw.session.deleteMany({where:{user}});await prismaRaw.registeredAgent.deleteMany({where:{user}});}
});

test('falsy core timestamps use the sealed clock including zero instead of a new clock or null',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 for(const timestamp of [null,'',0])for(const received_at_ms of [0,Date.parse(at)]){
  const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:'falsy',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms,completed_at_ms:null,operation_request:{data:{task_id:'task',framework:'pi-agent',timestamp,query:'query'}},provenance:{legacy_username:'alice'},snapshot:null};
  const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:core.collectorPreparationBinding(reservation),configs:[],skills:[],active_skill_versions:{},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:true,execution_match:null,thread_id:null};
  const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert.equal(result.snapshot.execution.timestamp,new Date(received_at_ms).toISOString());
 }
});

test('metadata-only legacy updates leave a pre-existing malformed Session body byte-for-byte intact',async()=>{
 const {prismaRaw}=await import('../src/lib/storage/prisma');
 const user='collector-corrupt-old-session',task='collector-corrupt-old';const raw='{"original_corrupt_json":';
 try{
  await service.saveExecutionRecord({task_id:task,framework:'pi-agent',user,query:'before',interactions:[],skip_evaluation:true});
  await prismaRaw.session.update({where:{taskId:task},data:{interactions:raw}});
  await service.saveExecutionRecord({task_id:task,framework:'pi-agent',user,query:'after',force_query_update:true,skip_evaluation:true});
  assert.equal((await prismaRaw.execution.findUniqueOrThrow({where:{id:task}})).query,'after');
  assert.equal((await prismaRaw.session.findUniqueOrThrow({where:{taskId:task}})).interactions,raw);
  const plan=service.prepareExecutionSession({record:{task_id:task},interactions:null,existingSession:{taskId:task,interactions:raw},defaultTimestamp:at});
  assert.equal(plan.session.interactions,raw);assert.equal(plan.create,null);assert.equal(plan.update,null);
 }finally{await prismaRaw.execution.deleteMany({where:{user}});await prismaRaw.session.deleteMany({where:{user}});await prismaRaw.registeredAgent.deleteMany({where:{user}});}
});

test('metadata-only core updates retain the already validated Session body without reparsing old storage',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 const session={taskId:'task',startTime:at,endTime:null,interactions:[{role:'user',content:'full original',extra:{zero:0,nil:null}}],query:'session query',label:'kept',model:null,user:'alice'};
 const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:'metadata',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'1',source_revision:'1',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'task',framework:'pi-agent',query:'new query',force_query_update:true}},provenance:{legacy_username:'alice'},snapshot:{execution:{id:'task',taskId:'task',timestamp:at,framework:'pi-agent'},session}};
 const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:core.collectorPreparationBinding(reservation),configs:[],skills:[],active_skill_versions:{},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:true,execution_match:null,thread_id:null};
 const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert.deepEqual(result.snapshot.session,session);assert.equal(result.snapshot.execution.query,'new query');
});

test('repeated headless completion retains the trusted prior Session clock and creates no Execution',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 const prior={taskId:'task',startTime:'2026-11-15T00:00:00.000Z',endTime:at,label:'original label',query:null,model:null,user:'alice',interactions:[],extension:{zero:0,nil:null}};
 const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:'again',operation:'complete',state:'reserved',input_hash:'a'.repeat(64),base_revision:'1',source_revision:'1',received_at_ms:Date.parse(at),completed_at_ms:Date.parse('2026-11-17T00:00:00Z'),operation_request:{task_id:'task'},provenance:{legacy_username:'alice'},snapshot:null};
 const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:core.collectorPreparationBinding(reservation),previous_session:prior};
 const result=core.prepareCoreCollectorCompletion(reservation,frozen);assert.equal(result.snapshot,null);assert.deepEqual(result.session,{...prior,endTime:'2026-11-17T00:00:00.000Z'});assert.equal(result.response.task_id,'task');
});

const collectorGraphNode=(spanId:string,startedAt=0)=>({traceId:'fixture-trace',spanId,parentSpanId:null,sourceParentSpanId:null,displayParentSpanId:null,name:spanId,kind:'span' as const,startedAt,completedAt:startedAt+1,durationMs:1,status:'success' as const,visibility:'visible' as const,input:{zero:0,nil:null}});
for(const framework of ['pi-agent','langfuse-langgraph'])for(const graphKind of ['malformed','valid'])for(const mode of ['metadata','messages','incoming-graph']){
 test(`legacy ${framework} ${mode} preserves unrelated ${graphKind} stored graph bytes`,async()=>{
  const {prismaRaw}=await import('../src/lib/storage/prisma');
  const suffix=`${framework}-${graphKind}-${mode}`,user='collector-graph-'+suffix,task='collector-graph-'+suffix;
  const oldNodes=[collectorGraphNode('old')],newNodes=[collectorGraphNode('new',2)];
  const graphRaw=graphKind==='malformed'?'{"original_broken_graph":':JSON.stringify(oldNodes,null,2);
  const oldBody=JSON.stringify([{id:'old',role:'user',content:'old body',timestamp:at}]);
  const newBody=[{id:'new',role:'user',content:'new complete source',timestamp:at}];
  try{
   await service.saveExecutionRecord({task_id:task,framework,user,query:'before',interactions:[],skip_evaluation:true});
   await prismaRaw.session.update({where:{taskId:task},data:{interactions:oldBody,langfuseTraceNodes:graphRaw}});
   await service.saveExecutionRecord({task_id:task,framework,user,query:'after',force_query_update:true,skip_evaluation:true,session_merge_strategy:'snapshot-replace',...(mode!=='metadata'?{interactions:newBody}:{}),...(mode==='incoming-graph'?{langfuseTraceNodes:newNodes}:{})});
   const stored=await prismaRaw.session.findUniqueOrThrow({where:{taskId:task}});
   assert.equal((await prismaRaw.execution.findUniqueOrThrow({where:{id:task}})).query,'after');
   assert.equal(stored.interactions,mode==='metadata'?oldBody:JSON.stringify(newBody));
   if(framework==='langfuse-langgraph'&&mode==='incoming-graph')assert.deepEqual(JSON.parse(stored.langfuseTraceNodes!),graphKind==='valid'?[...oldNodes,...newNodes]:newNodes);
   else assert.equal(stored.langfuseTraceNodes,graphRaw);
  }finally{await prismaRaw.execution.deleteMany({where:{user}});await prismaRaw.session.deleteMany({where:{user}});await prismaRaw.registeredAgent.deleteMany({where:{user}});}
 });
}

test('shared Session preparation preserves storage representation and only merges requested canonical LF graph updates',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 const oldNodes=[collectorGraphNode('old')],newNodes=[collectorGraphNode('new',2)],messages=[{id:'message',role:'user',content:'complete original',timestamp:at}];
 for(const framework of ['pi-agent','langfuse-langgraph'])for(const interactions of [null,messages]){
  const storage={taskId:'task',startTime:at,interactions:'{"old_bad_body":',langfuseTraceNodes:'{"old_bad_graph":'};
  const untouched=service.prepareExecutionSession({record:{task_id:'task',framework},interactions,existingSession:storage,defaultTimestamp:at});
  assert.equal(untouched.session.langfuseTraceNodes,storage.langfuseTraceNodes);
  assert.deepEqual(untouched.session.interactions,interactions??storage.interactions);
 }
 for(const incoming of [undefined,newNodes]){
  const session={taskId:'task',startTime:at,endTime:null,interactions:messages,langfuseTraceNodes:oldNodes,label:'original',query:'query',model:null,user:'alice'};
  const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:'canonical-graph',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'1',source_revision:'1',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'task',framework:'langfuse-langgraph',interactions:messages,...(incoming?{langfuseTraceNodes:incoming}:{})}},provenance:{legacy_username:'alice'},snapshot:{execution:{id:'task',taskId:'task',timestamp:at,framework:'langfuse-langgraph'},session}};
  const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:core.collectorPreparationBinding(reservation),configs:[],skills:[],active_skill_versions:{},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:false,execution_match:null,thread_id:null};
  const before=JSON.stringify(reservation);const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);
  assert.deepEqual(result.snapshot.session.langfuseTraceNodes,incoming?[...oldNodes,...newNodes]:oldNodes);assert.equal(JSON.stringify(reservation),before);
 }
 const direct=service.prepareExecutionSession({record:{task_id:'task',framework:'langfuse-langgraph',langfuseTraceNodes:newNodes},interactions:messages,existingSession:{taskId:'task',startTime:at,interactions:messages,langfuseTraceNodes:oldNodes},defaultTimestamp:at});
 assert.deepEqual(direct.session.langfuseTraceNodes,[...oldNodes,...newNodes]);
 assert.throws(()=>service.prepareExecutionSession({record:{task_id:'task',framework:'langfuse-langgraph',langfuseTraceNodes:[null] as any},interactions:messages,existingSession:{taskId:'task',startTime:at,langfuseTraceNodes:'bad old graph'},defaultTimestamp:at}),TypeError);
});

for(const previousPi of [false,true])for(const variant of ['missing','null','empty']){
 test(`legacy framework ${variant} with ${previousPi?'existing Pi':'new source'} selects the original effective shrink capability`,async()=>{
  const {prismaRaw}=await import('../src/lib/storage/prisma');
  const user=`collector-framework-${previousPi}-${variant}`,task=user;
  const oldBody=[{id:'one',role:'user',content:'old one',timestamp:at},{id:'two',role:'assistant',content:'old two',timestamp:at}];
  const newBody=[{id:'one',role:'user',content:'new one',timestamp:at}];
  try{
   if(previousPi)await service.saveExecutionRecord({task_id:task,framework:'pi-agent',user,query:'before',interactions:oldBody,skip_evaluation:true});
   const data:any={task_id:task,user,query:'after',force_query_update:true,interactions:newBody,session_merge_strategy:'snapshot-replace',skip_evaluation:true};
   if(variant!=='missing')data.framework=variant==='null'?null:'';
   await service.saveExecutionRecord(data);
   const execution=await prismaRaw.execution.findUniqueOrThrow({where:{id:task}}),session=await prismaRaw.session.findUniqueOrThrow({where:{taskId:task}});
   const skipped=previousPi&&variant!=='missing';
   assert.deepEqual(JSON.parse(session.interactions!),skipped?oldBody:newBody);
   assert.equal(execution.query,skipped?'before':'after');assert.equal(execution.framework,previousPi?'pi-agent':variant==='empty'?'':null);
  }finally{await prismaRaw.execution.deleteMany({where:{user}});await prismaRaw.session.deleteMany({where:{user}});await prismaRaw.registeredAgent.deleteMany({where:{user}});}
 });
}

async function collectorTestIdentity(user:string){
 const {resolveCoreCollectorIdentity}=await import('../src/lib/storage-core/collector-identity');
 const previous=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:58763';let calls=0;
 const fetcher:typeof fetch=async(input)=>{
  calls++;const url=new URL(String(input));assert.equal(url.origin,'http://127.0.0.1:58763');
  if(url.pathname==='/v1/auth/me')return Response.json({principal_id:'collector-principal',username:user,workspace_id:'collector-workspace',workspaces:[{workspace_id:'collector-workspace'}]});
  assert.equal(url.pathname,'/v1/compat/collector-source');return Response.json({value:{authorized:true,operation:'snapshot',principal_id:'collector-principal',workspace_id:'collector-workspace'}});
 };
 try{
  const identity=await resolveCoreCollectorIdentity(new Request('http://isolated/upload',{headers:{'x-witty-api-key':'api_'+'q'.repeat(43)}}),{operation:'snapshot'},{fetcher});
  return {identity,calls:()=>calls,restore:()=>{if(previous===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous;}};
 }catch(error){if(previous===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous;throw error;}
}

test('real branded capture and static Prisma distinguish missing framework from explicit null and empty for old/new sources',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');const {prismaRaw}=await import('../src/lib/storage/prisma');
 const user='collector-capture-framework';await prismaRaw.userSettings.create({data:{user,settingsJson:JSON.stringify({autoEvaluationEnabled:false})}});
 const auth=await collectorTestIdentity(user);
 const oldBody=[{id:'one',role:'user',content:'old one',timestamp:at},{id:'two',role:'assistant',content:'old two',timestamp:at}],newBody=oldBody.slice(0,1);
 try{
  for(const previousPi of [false,true])for(const variant of ['missing','null','empty']){
   const data:any={task_id:'task',query:'query',interactions:newBody,session_merge_strategy:'snapshot-replace'};if(variant!=='missing')data.framework=variant==='null'?null:'';
   const snapshot=previousPi?{execution:{id:'task',taskId:'task',framework:'pi-agent',timestamp:at},session:{taskId:'task',startTime:at,interactions:oldBody,query:'query'}}:null;
   const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:`${previousPi}-${variant}`,operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:previousPi?'1':'0',source_revision:previousPi?'1':'0',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data},provenance:{legacy_username:user},snapshot};
   const frozen=await core.captureCoreCollectorPreparation(auth.identity,reservation);const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);
   assert.equal(frozen.allow_snapshot_shrink,previousPi&&variant==='missing');assert.equal(result.skipped,previousPi&&variant!=='missing');assert.deepEqual(result.snapshot.session.interactions,previousPi&&variant!=='missing'?oldBody:newBody);
  }
  assert(auth.calls()>=6);
 }finally{auth.restore();await prismaRaw.userSettings.delete({where:{user}});}
});

test('capture selects the incoming natural Thread binding and preserves the original old-to-new association change',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');const {prismaRaw}=await import('../src/lib/storage/prisma');
 const user='collector-thread-switch',task='collector-thread-switch';await prismaRaw.userSettings.create({data:{user,settingsJson:JSON.stringify({autoEvaluationEnabled:false})}});const auth=await collectorTestIdentity(user);
 try{
  await service.saveExecutionRecord({task_id:task,framework:'codex',user,query:'before',timestamp:at,interactions:[],skip_evaluation:true,traceThread:{sourceThreadId:'old-thread'}});
  const old=await prismaRaw.execution.findUniqueOrThrow({where:{id:task}});const next=await prismaRaw.traceThread.create({data:{framework:'codex',sourceThreadId:'new-thread',user}});
  const data={task_id:task,framework:'codex',query:'after',timestamp:at,force_query_update:true,interactions:[],traceThread:{sourceThreadId:'new-thread'}};
  const reservation:any={trace_id:'trace',task_id:task,execution_id:task,operation_key:'switch',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'1',source_revision:'1',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data},provenance:{legacy_username:user},snapshot:{execution:{id:task,taskId:task,framework:'codex',timestamp:at,traceThreadId:old.traceThreadId},session:{taskId:task,startTime:at,interactions:[]}}};
  const frozen=await core.captureCoreCollectorPreparation(auth.identity,reservation,{threadId:next.id});const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);
  await service.saveExecutionRecord({...data,user,skip_evaluation:true});assert.equal((await prismaRaw.execution.findUniqueOrThrow({where:{id:task}})).traceThreadId,next.id);assert.equal(await prismaRaw.traceThread.count({where:{user}}),2);
  assert.equal(frozen.thread_id,next.id);assert.equal(result.thread.thread.id,next.id);assert.equal(result.thread.thread.sourceThreadId,'new-thread');assert.equal(result.snapshot.execution.traceThreadId,next.id);
  const withoutLookup=await core.captureCoreCollectorPreparation(auth.identity,reservation);assert.notEqual(withoutLookup.thread_id,old.traceThreadId);assert.equal(withoutLookup.thread_id,(await core.captureCoreCollectorPreparation(auth.identity,reservation)).thread_id);
 }finally{auth.restore();await prismaRaw.execution.deleteMany({where:{user}});await prismaRaw.session.deleteMany({where:{user}});await prismaRaw.traceThread.deleteMany({where:{user}});await prismaRaw.registeredAgent.deleteMany({where:{user}});await prismaRaw.userSettings.delete({where:{user}});}
});

test('core Thread planning uses the original raw-stage framework condition and never inherits permission to write a new Thread',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');const {prismaRaw}=await import('../src/lib/storage/prisma');
 const user='collector-thread-raw-condition',task=user;await prismaRaw.userSettings.create({data:{user,settingsJson:JSON.stringify({autoEvaluationEnabled:false})}});const auth=await collectorTestIdentity(user);
 try{
  await service.saveExecutionRecord({task_id:task,framework:'codex',user,query:'before',timestamp:at,interactions:[],skip_evaluation:true,traceThread:{sourceThreadId:'existing-thread'}});
  const old=await prismaRaw.execution.findUniqueOrThrow({where:{id:task}});
  const data={task_id:task,query:'after',timestamp:at,force_query_update:true,interactions:[],traceThread:{sourceThreadId:'ignored-new-thread'}};
  const reservation:any={trace_id:'trace',task_id:task,execution_id:task,operation_key:'raw-condition',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'1',source_revision:'1',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data},provenance:{legacy_username:user},snapshot:{execution:{id:task,taskId:task,framework:'codex',timestamp:at,traceThreadId:old.traceThreadId},session:{taskId:task,startTime:at,interactions:[]}}};
  const frozen=await core.captureCoreCollectorPreparation(auth.identity,reservation);const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);
  await service.saveExecutionRecord({...data,user,skip_evaluation:true});assert.equal(await prismaRaw.traceThread.count({where:{user}}),1);assert.equal((await prismaRaw.execution.findUniqueOrThrow({where:{id:task}})).traceThreadId,old.traceThreadId);
  assert.equal(result.thread,null);assert.equal(result.snapshot.execution.traceThreadId,old.traceThreadId);assert.equal(result.post_hooks.find((hook:any)=>hook.kind==='reconcile_trace_thread').threadId,old.traceThreadId);
 }finally{auth.restore();await prismaRaw.execution.deleteMany({where:{user}});await prismaRaw.session.deleteMany({where:{user}});await prismaRaw.traceThread.deleteMany({where:{user}});await prismaRaw.registeredAgent.deleteMany({where:{user}});await prismaRaw.userSettings.delete({where:{user}});}
});

test('real static capture reads lightweight owner names and only selected Skill ID/version bodies with original JS case selection',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');const {prismaRaw,db}=await import('../src/lib/storage/prisma');
 const user='collector-capture-read-scope';await prismaRaw.userSettings.create({data:{user,settingsJson:JSON.stringify({autoEvaluationEnabled:false})}});
 const seeds=[] as any[];
 for(const name of ['Änalysis','änalysis','related-two','unrelated-a','unrelated-b','fallback-skill'])seeds.push(await prismaRaw.skill.create({data:{name,user,activeVersion:name==='fallback-skill'?77:0,versions:{create:[{version:0,content:'BODY '+name+' v0'},{version:2,content:'BODY '+name+' v2'}]}}}));
 const expected=await db.findSkill('ÄNALYSIS',user);assert(expected);
 const config=await prismaRaw.config.create({data:{query:'related query',skill:expected.name,datasetType:'routing',routingIntent:'related query',routingAnchors:'["related query"]',expectedSkills:JSON.stringify([{skill:expected.name,version:0},{skill:'related-two',version:2}]),standardAnswer:'',user}});
 const auth=await collectorTestIdentity(user);const reads:any[]=[];
 const adapter=db as any,originalClient=adapter.client;
 const skillDelegate=prismaRaw.skill as any,versionDelegate=prismaRaw.skillVersion as any,skillFind=skillDelegate.findMany,versionFind=versionDelegate.findMany;
 const observe=(kind:string,args:any,rows:any[])=>{reads.push({kind,args:structuredClone(args),rows:structuredClone(rows)});return rows;};
 adapter.client=originalClient.$extends({query:{skill:{async findMany({args,query}:any){return observe('legacy-skill',args,await query(args));}}}});
 skillDelegate.findMany=async(args:any)=>observe('skill',args,await Reflect.apply(skillFind,skillDelegate,[args]));
 versionDelegate.findMany=async(args:any)=>observe('skill-version',args,await Reflect.apply(versionFind,versionDelegate,[args]));
 try{
  for(const [skill,query,expectedVersion] of [['ÄNALYSIS','related query',0],['fallback-skill','unmatched',2]] as const){
   const reservation:any={trace_id:'trace',task_id:'task',execution_id:'task',operation_key:skill,operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'task',framework:'pi-agent',skill,query,interactions:[]}},provenance:{legacy_username:user},snapshot:null};
   const frozen=await core.captureCoreCollectorPreparation(auth.identity,reservation);const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert.equal(result.snapshot.execution.skillVersion,expectedVersion);
   if(skill==='ÄNALYSIS')assert.equal(frozen.skills.find(row=>row.name.toLowerCase()==='änalysis')!.id,expected.id);
  }
  assert(reads.length>0);assert.equal(reads.some(read=>read.kind==='legacy-skill'&&read.rows.some((row:any)=>row.versions?.some((version:any)=>typeof version.content==='string'))),false,'No all-owner Skill body reads');
  const selected=new Set([expected.id,seeds.find(row=>row.name==='related-two').id,seeds.find(row=>row.name==='fallback-skill').id]);
  for(const read of reads){
   if(read.kind==='skill'){assert.equal(read.args.include,undefined);assert.equal(read.args.select.versions,undefined);assert.equal(read.args.select.content,undefined);}
   if(read.kind==='skill-version'&&read.args.select.content){assert(selected.has(read.args.where.skillId));assert(Array.isArray(read.args.where.version.in));assert(read.rows.length<=read.args.where.version.in.length);}
  }
  assert(reads.some(read=>read.kind==='skill-version'&&read.args.select.content));
 }finally{adapter.client=originalClient;skillDelegate.findMany=skillFind;versionDelegate.findMany=versionFind;auth.restore();await prismaRaw.config.delete({where:{id:config.id}});await prismaRaw.skillVersion.deleteMany({where:{skillId:{in:seeds.map(row=>row.id)}}});await prismaRaw.skill.deleteMany({where:{user}});await prismaRaw.userSettings.delete({where:{user}});}
});

test('capture retains exact-case routing version lookup separately from JS-folded business Skill selection',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');const {prismaRaw}=await import('../src/lib/storage/prisma');const user='collector-case-routing',task=user;
 await prismaRaw.userSettings.create({data:{user,settingsJson:JSON.stringify({autoEvaluationEnabled:false})}});
 const skills=[] as any[];for(const [name,activeVersion] of [['Mixed',0],['mixed',2]] as const)skills.push(await prismaRaw.skill.create({data:{name,user,activeVersion,versions:{create:[{version:0,content:'zero '+name},{version:2,content:'two '+name}]}}}));
 const config=await prismaRaw.config.create({data:{query:'case query',skill:'mixed',datasetType:'routing',routingIntent:'case query',routingAnchors:'["case query"]',expectedSkills:'[{"skill":"mixed","version":2}]',standardAnswer:'',user}});const auth=await collectorTestIdentity(user);
 try{
  const data={task_id:task,framework:'pi-agent',query:'case query',timestamp:at,interactions:[{role:'assistant',content:'load business Skill',timestamp:at,tool_calls:[{id:'skill',name:'skill',arguments:'{"name":"mixed"}'}]}]};
  const reservation:any={trace_id:'trace',task_id:task,execution_id:task,operation_key:'case-routing',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data},provenance:{legacy_username:user},snapshot:null};
  const frozen=await core.captureCoreCollectorPreparation(auth.identity,reservation);const result:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);
  const {quickData}=await service.prepareUploadQuickData(data,user);assert.equal(quickData.skill_version,0);await service.saveExecutionRecord({...quickData,user});const actual=await prismaRaw.execution.findUniqueOrThrow({where:{id:task}});assert.equal(actual.isSkillCorrect,true);
  assert.equal(result.snapshot.execution.isSkillCorrect,actual.isSkillCorrect);assert.equal(result.record.routing_evaluation.is_correct,true);assert.equal(frozen.skills.find(row=>row.name.toLowerCase()==='mixed')!.id,skills[0].id);
 }finally{auth.restore();await prismaRaw.execution.deleteMany({where:{user}});await prismaRaw.session.deleteMany({where:{user}});await prismaRaw.registeredAgent.deleteMany({where:{user}});await prismaRaw.config.delete({where:{id:config.id}});await prismaRaw.skillVersion.deleteMany({where:{skillId:{in:skills.map(row=>row.id)}}});await prismaRaw.skill.deleteMany({where:{user}});await prismaRaw.userSettings.delete({where:{user}});}
});

test('an uncorrelated pending Codex execution stops before even a thread-only plan',async()=>{
 const core=await import('../src/lib/storage-core/collector-preparation');
 const reservation:any={trace_id:'trace',task_id:'session',execution_id:'pending:child',operation_key:'pending',operation:'snapshot',state:'reserved',input_hash:'a'.repeat(64),base_revision:'0',source_revision:'0',received_at_ms:Date.parse(at),completed_at_ms:null,operation_request:{data:{task_id:'session',framework:'codex',threadOnly:true,traceThread:{sourceThreadId:'never-created',events:[{eventKey:'event',kind:'interrupt',startedAt:at}]}}},provenance:{legacy_username:'alice'},snapshot:null};
 const frozen:any={version:1,actor:{principal:'p',workspace:'w',username:'alice'},binding:core.collectorPreparationBinding(reservation),thread_id:'never-created'};
 const value:any=await core.prepareCoreCollectorSnapshot(reservation,frozen);assert.equal(value.disposition,'pending_parent');assert.equal(value.skipped,true);assert.equal(value.thread,null);assert.equal(value.snapshot,null);assert.deepEqual(value.post_hooks,[]);
});
