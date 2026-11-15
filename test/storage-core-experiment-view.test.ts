import assert from 'node:assert/strict';
import test from 'node:test';
const snapshot={coverage:'complete',experiment:{id:'exp',user:'alice',name:'原实验',type:'single',scope:'',status:'done',deletedAt:null,createdAt:'2026-11-14T00:00:00.000Z',cases:[{id:'a',experimentId:'exp',deletedAt:null,createdAt:'2026-11-14T00:00:00.000Z',results:[{id:'ra',experimentId:'exp',caseId:'a',evaluatorId:'eval',status:'done',score:80,humanScore:0}],traceAttempts:[]},{id:'b',experimentId:'exp',deletedAt:null,createdAt:'2026-11-14T00:01:00.000Z',results:[{id:'rb',experimentId:'exp',caseId:'b',evaluatorId:'eval',status:'failed',score:null,humanScore:null}],traceAttempts:[]}],groups:[],comments:[]},executions:[],sessions:[],cancellations:[]};
test('the complete domain view keeps all rows for aggregation while case reads paginate',async()=>{
 const {createExperimentReadView}=await import('../src/lib/storage-core/experiment-view');const source=createExperimentReadView([snapshot]);
 assert.equal(await source.experimentCase.count({where:{experimentId:'exp',deletedAt:null}}),2);
 const rows=await source.experimentCase.findMany({where:{experimentId:'exp'},orderBy:{createdAt:'asc'},skip:1,take:1,include:{results:true}});assert.equal(rows[0].id,'b');assert.equal(rows[0].results[0].score,null);
 const result=await source.experimentEvalResult.findMany({where:{experimentId:'exp',case:{deletedAt:null}},select:{id:true,score:true,humanScore:true}});assert.deepEqual(result,[{id:'ra',score:80,humanScore:0},{id:'rb',score:null,humanScore:null}]);
});
test('view relation counts, nested includes and ordering use the same complete snapshot',async()=>{
 const {createExperimentReadView}=await import('../src/lib/storage-core/experiment-view');const source=createExperimentReadView([snapshot]);
 const row=await source.experiment.findFirst({where:{id:'exp',user:'alice'},include:{_count:{select:{cases:{where:{deletedAt:null}}}},cases:{orderBy:{createdAt:'desc'},take:1,include:{results:true}}}});assert.ok(row);assert.equal(row._count.cases,2);assert.equal(row.cases[0].id,'b');assert.equal(row.cases[0].results[0].id,'rb');
 assert.equal(await source.experiment.findUnique({where:{id:'missing'}}),null);
});
test('partial snapshots and unsupported tables or mutations cannot fall back to the old database',async()=>{
 const {createExperimentReadView}=await import('../src/lib/storage-core/experiment-view');assert.throws(()=>createExperimentReadView([{...snapshot,coverage:'page'}]),/complete|coverage/i);const source=createExperimentReadView([snapshot]);
 assert.throws(()=>source.experiment.update({where:{id:'exp'},data:{name:'lost'}}),/read.only|mutation/i);assert.throws(()=>Reflect.get(source,'unknown').findMany({}),/unsupported/i);assert.throws(()=>source.$transaction(async()=>{}),/read.only|transaction/i);
});

test('the verified actor filter cannot hide an IAM-authorized group record or change an explicit different owner filter',async()=>{
 const {createExperimentReadView}=await import('../src/lib/storage-core/experiment-view');const source=createExperimentReadView([snapshot],{actorUsername:'admin'});
 assert.equal(await source.experiment.count({where:{user:'admin',deletedAt:null}}),1);assert.equal(await source.experiment.count({where:{user:'bob'}}),0);
});

test('internal immutable result provenance is available explicitly without changing the old default result DTO',async()=>{
 const {createExperimentReadView}=await import('@/lib/storage-core/experiment-view');
 const result={id:'result',caseId:'case',experimentId:'exp',score:80,coreResult:{machineResultId:'machine',contentHash:'a'.repeat(64),runId:'run'}};
 const view=createExperimentReadView([{coverage:'complete',experiment:{id:'exp',cases:[{id:'case',experimentId:'exp',results:[result]}],groups:[],comments:[]}}]);
 const plain=await view.experimentEvalResult.findUnique({where:{id:'result'}});assert.equal(Object.hasOwn(plain!,'coreResult'),false);assert.equal(plain?.score,80);
 const projected=await (view.experimentEvalResult as unknown as {findUnique:(query:unknown)=>Promise<{coreResult:unknown}>}).findUnique({where:{id:'result'},select:{coreResult:true}});assert.deepEqual(projected.coreResult,result.coreResult);
});

test('a read view can cross an async return without becoming a thenable',async()=>{
 const {createExperimentReadView}=await import('../src/lib/storage-core/experiment-view');const view=createExperimentReadView([]);
 const resolved=await (async()=>view)();assert.equal(resolved,view);assert.equal((view as unknown as {then?:unknown}).then,undefined);
 assert.throws(()=>(view as unknown as {unknownModel:unknown}).unknownModel,/Unsupported|incomplete/);
});

test('Session rows retain the original Prisma string and Date contract without changing frozen evidence',async()=>{
 const {createExperimentReadView}=await import('../src/lib/storage-core/experiment-view');
 const interactions=[{role:'user',content:'问题'},{role:'assistant',content:'回答',opaque:{keep:true}}];const nodes=[{id:'node',value:false}];
 const original={...snapshot,sessions:[{taskId:'task',interactions,langfuseTraceNodes:nodes,startTime:'2026-11-14T00:00:00Z',endTime:null}],executions:[{id:'execution',timestamp:'2026-11-14T00:00:00Z'}]};
 const missing=createExperimentReadView([{...snapshot,sessions:[{taskId:'missing',startTime:'2026-11-14T00:00:00Z'}]}]);assert.equal((await missing.session.findUniqueOrThrow({where:{taskId:'missing'},select:{endTime:true}})).endTime,null);
 const view=createExperimentReadView([original]);const row=await view.session.findUniqueOrThrow({where:{taskId:'task'}});
 assert.equal(typeof row.interactions,'string');assert.deepEqual(JSON.parse(row.interactions!),interactions);assert.deepEqual(JSON.parse(row.langfuseTraceNodes!),nodes);assert.ok(row.startTime instanceof Date);assert.equal(row.endTime,null);
 const execution=await view.execution.findUniqueOrThrow({where:{id:'execution'}});assert.ok(execution.timestamp instanceof Date);assert.equal(original.sessions[0].interactions,interactions);assert.equal(original.sessions[0].langfuseTraceNodes,nodes);
});

test('native execution rows apply the original non-null Prisma root default and keep true subagents',async()=>{
 const {createExperimentReadView}=await import('../src/lib/storage-core/experiment-view');
 const original={...snapshot,executions:[{id:'root',taskId:'local-task',isSubagent:null},{id:'child',taskId:'child-task',isSubagent:true}]};
 const source=createExperimentReadView([original]);const rows=await source.execution.findMany({where:{isSubagent:false},select:{id:true}});assert.deepEqual(rows,[{id:'root'}]);assert.equal(original.executions[0].isSubagent,null);
});
