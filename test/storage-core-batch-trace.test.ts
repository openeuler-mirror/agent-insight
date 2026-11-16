import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
interface FixtureResult {
    evaluatorId: string;
    status: string;
    score?: number;
    coreResult?: object | null;
    errorMessage?: string;
    createdAt?: string;
    coreWork?: {
        createdAt: string;
        startedAt: string;
        finishedAt?:string;
    };
}
interface FixtureExperiment {
    id: string;
    user: string;
    status: string;
    skillName: string;
    skillVersion: number;
    evaluatorIdsJson: string;
    cases: Array<{
        id: string;
        taskId: string;
        results: FixtureResult[];
    }>;
}
interface FixtureConfig {
    sourceMode: string;
    skillId: string;
    versionId?: string;
    evalExperimentId: string;
    coreTraceBindings: Record<string, string>;
    coreTraceOperation?: {
        key: string;
        caseIds: string[];
        action: string;
        phase: string;
    };
}
interface FixtureTask {
    id: string;
    user: string;
    configJson: string;
    caseStatesJson: string;
    traceEvalStatesJson: string;
}
interface ProjectedState {
    status: string;
    score?: number;
    sessionId?: string;
    startedAt?: number;
    [key: string]: unknown;
}
interface ParsedTask {
    user: string;
    configJson: object;
    caseStatesJson: object;
    traceEvalStatesJson?: object;
}
interface HelperApi {
    projectCoreBatchTask(task: ParsedTask): Promise<{
        caseStatesJson: Record<string, ProjectedState>;
        traceEvalStatesJson: Record<string, ProjectedState>;
    }>;
    startCoreBatchTrace(task: FixtureTask, ids: string[], retry?: boolean): Promise<void>;
    abortCoreBatchTrace(task: FixtureTask): Promise<unknown>;
    preserveCoreBatchBindings(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> & {
        coreTraceBindings: Record<string, string>;
    };
}
function load<T>(path: string, deps: Record<string, unknown>): T {
    const sandboxModule: {
        exports: unknown;
    } = { exports: {} };
    if (!fs.existsSync(path))
        return {} as T;
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module: sandboxModule, exports: sandboxModule.exports, require: (name: string) => deps[name] ?? {}, Response, Request, URL, Headers, console, structuredClone, Date, Set, Map, JSON });
    return sandboxModule.exports as T;
}
const receipt = { machineResultId: 'm', contentHash: 'hash', runId: 'r', planHash: 'p', evaluationVersion: 1 };
function setup() {
    const calls: string[] = [];
    const replay={found:false,latestUnavailable:false};
    const scope={allowed:true};
    const lifecycle={state:'active'};
    const config: FixtureConfig = { sourceMode: 'trace', skillId: 's', versionId: 'v', evalExperimentId: 'exp', coreTraceBindings: { one: 'c1', two: 'c2' } };
    const task: FixtureTask = { id: 'batch', user: 'trusted', configJson: JSON.stringify(config), caseStatesJson: JSON.stringify({ one: { status: 'pass', score: 99, sessionId: 'forged' }, two: { status: 'pass', score: 99 } }), traceEvalStatesJson: '{}' };
    const exp: FixtureExperiment = { id: 'exp', user: 'trusted', status: 'done', skillName: 'skill', skillVersion: 2, evaluatorIdsJson: '["a","b"]', cases: [{ id: 'c1', taskId: 'one', results: [{ evaluatorId: 'a', status: 'done', score: 80, coreResult: receipt }, { evaluatorId: 'b', status: 'failed', errorMessage: 'bad', coreResult: receipt }] }, { id: 'c2', taskId: 'two', results: [{ evaluatorId: 'a', status: 'done', score: 71, coreResult: receipt }, { evaluatorId: 'b', status: 'done', score: 80, coreResult: receipt }] }] };
    const context = { actor: { username: 'trusted', principal: 'principal', workspace:'w' }, request: new Request('http://localhost'), options: {}, operationKey: 'request', rpc: async (action: string,payload?:{operation:string;experiment_id?:string}) => { calls.push(action); if(action==='batch_scope'){if(!scope.allowed)throw Object.assign(Error('read only'),{status:403});return {authorized:true,operation:payload?.operation,principal_id:'principal',workspace_id:'w',...(payload?.experiment_id?{experiment_id:payload.experiment_id,lifecycle:lifecycle.state}:{})};} return { gold_redacted: exp.user !== 'trusted', experiment: exp }; } };
    const prisma = { batchEvalTask: { updateMany: async ({ where, data }: {
                where: {
                    configJson: string;
                    caseStatesJson?: string;
                };
                data: Partial<FixtureTask>;
            }) => { calls.push('bind'); if (where.configJson !== task.configJson || where.caseStatesJson !== undefined && where.caseStatesJson !== task.caseStatesJson)
                return { count: 0 }; Object.assign(task, data); return { count: 1 }; } }, skill: { findFirst: async () => ({ name: 'skill' }) }, skillVersion: { findFirst: async () => ({ version: 2 }) } };
    const deps: Record<string, unknown> = {
        '@/lib/storage/prisma': { prisma },
        './experiments': { requireCoreExperimentContext: () => context, lookupCoreExperimentOperation:async()=>replay.found?{experiment:exp}:null },
        './experiment-assets':load('src/lib/storage-core/experiment-assets.ts',{'node:crypto':{createHash}}),
        './experiment-worker':{activateExperimentWork:async()=>{calls.push('activate');}},
        './evidence': { readTraceEvidence: async (_req: Request, { taskId }: {
                taskId: string;
            }) => { calls.push('evidence:' + taskId); return { evidence: { manifest: { owner_principal_id: 'principal' }, execution: { id: 'exec-' + taskId, taskId, query: 'real input', finalResult: 'real output' } } }; } },
        '@/lib/engine/experiment/run-experiment': { ensureEvalExperiment: async () => { calls.push('ensure'); return 'exp'; }, addEvalExperimentCase: async (_id: string, c: {
                taskId: string;
                input: string;
            }) => { calls.push('case:' + c.taskId); assert.equal(c.input, 'real input'); return c.taskId === 'one' ? 'c1' : 'c2'; }, startEvalExperimentCases: async (_id: string, ids: string[]) => { if(replay.latestUnavailable)throw Error('Latest model is unavailable'); calls.push('start:' + ids.join(',')); return { status: 'running', completion: Promise.resolve() }; } },
        './experiment-cancellation': { cancelCoreExperimentExecution: async () => { calls.push('cancel'); return { id: 'cancel', status: 'completed' }; } }
    };
    return { api: load<HelperApi>('src/lib/storage-core/batch-trace.ts', deps), calls, task, exp, context, config, prisma, replay, scope, lifecycle };
}
test('Batch Trace flat DTO uses selected machine receipts and old partial-success mean', async () => { const { api, task } = setup(); assert.equal(typeof api.projectCoreBatchTask, 'function'); const projected = await api.projectCoreBatchTask({ ...task, configJson: JSON.parse(task.configJson), caseStatesJson: JSON.parse(task.caseStatesJson), traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson) }); assert.equal(projected.caseStatesJson.one.status, 'pass'); assert.equal(projected.caseStatesJson.one.score, 80); assert.equal(projected.caseStatesJson.one.sessionId, 'one'); assert.equal(projected.caseStatesJson.two.score, 76); assert.equal(projected.caseStatesJson.one.a, undefined); });
test('unreceipted client and annotation scores never become Batch machine facts', async () => { const { api, task, exp } = setup(); for (const c of exp.cases)
    for (const r of c.results)
        delete r.coreResult; const result = await api.projectCoreBatchTask({ ...task, configJson: JSON.parse(task.configJson), caseStatesJson: JSON.parse(task.caseStatesJson), traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson) }); assert.equal(result.caseStatesJson.one.score, undefined); assert.equal(result.caseStatesJson.one.status, 'pending'); });
test('all Trace sources validate before binding and durable selected work is created before success', async () => { const { api, task, calls } = setup(); assert.equal(typeof api.startCoreBatchTrace, 'function'); await api.startCoreBatchTrace(task, ['one', 'two']); assert.ok(calls.indexOf('evidence:two') < calls.indexOf('ensure')); assert.ok(calls.indexOf('bind') < calls.indexOf('start:c1,c2')); });
test('single Trace retry starts only its bound Case', async () => { const { api, task, calls } = setup(); await api.startCoreBatchTrace(task, ['one'], true); assert.ok(calls.includes('start:c1')); assert.ok(!calls.includes('case:two')); });
test('foreign backing Experiment fails before source mutation or ensure fallback', async () => { const { api, task, exp, calls } = setup(); exp.user = 'other'; await assert.rejects(() => api.startCoreBatchTrace(task, ['one']), { status: 403 }); assert.ok(!calls.includes('ensure')); assert.ok(!calls.includes('bind')); });
test('explicit Skill version is required and never resolves active version', async () => { const { api, task, config, calls } = setup(); delete config.versionId; task.configJson = JSON.stringify(config); await assert.rejects(() => api.startCoreBatchTrace(task, ['one']), { status: 400 }); assert.ok(!calls.includes('ensure')); });
test('durable abort uses Experiment cancellation and survives absent in-memory registry', async () => { const { api, task, calls } = setup(); assert.equal(typeof api.abortCoreBatchTrace, 'function'); await api.abortCoreBatchTrace(task); assert.ok(calls.includes('cancel')); });
test('PATCH cannot inject backing bindings or replace a bound context', () => { const { api } = setup(); assert.equal(typeof api.preserveCoreBatchBindings, 'function'); const result = api.preserveCoreBatchBindings({ evalExperimentId: 'exp', sourceMode: 'trace', coreTraceBindings: { one: 'c1' } }, { sourceMode: 'trace', evalExperimentId: 'exp', coreTraceBindings: { one: 'evil' } }); assert.equal(result.coreTraceBindings.one, 'c1'); assert.throws(() => api.preserveCoreBatchBindings({ evalExperimentId: 'exp', sourceMode: 'trace' }, { sourceMode: 'dataset' }), { status: 409 }); });
for (const path of ['src/app/api/debug/batch-tasks/route.ts', 'src/app/api/debug/batch-tasks/[taskId]/route.ts'])
    test('original Batch route normalizes forged actor before static control read: ' + path, async () => { let context: {
        compatibilityRoute: boolean;
    } | undefined; let actor: string | undefined; let scopes = 0; const deps: Record<string, unknown> = { 'next/server': { NextResponse: Response }, '@/lib/storage-core/mode': { isStorageCoreEnabled: () => true }, '@/lib/storage-core/experiments': { getCoreExperimentContext: () => context }, '@/lib/storage-core/workbench': { withCoreWorkbenchRoute: async (request: Request, next: (request: {
                url: string;
            }) => Promise<Response>) => { scopes++; context = { compatibilityRoute: true }; const url = new URL(request.url); url.searchParams.set('user', 'trusted'); return next({ url: String(url) }); } }, '@/lib/storage/prisma': { prisma: { batchEvalTask: { findFirst: async ({ where }: {
                        where: {
                            user: string;
                        };
                    }) => { actor = where.user; return null; }, findMany: async ({ where }: {
                        where: {
                            user: string;
                        };
                    }) => { actor = where.user; return []; } } } }, '@/lib/storage-core/batch-trace': {assertCoreBatchScope:async()=>{}, projectCoreBatchTask: async (t: unknown) => t } }; const api = load<{
        GET: (request: {
            url: string;
        }, options: object) => Promise<Response>;
    }>(path, deps); const response = await api.GET({ url: 'http://localhost/api/debug/batch-tasks/x?user=forged' }, { params: Promise.resolve({ taskId: 'x' }) }); assert.ok([200, 404].includes(response.status)); assert.equal(scopes, 1); assert.equal(actor, 'trusted'); });
test('Trace legacy side score cannot override the current typed machine score', async () => { const { api, task } = setup(); const result = await api.projectCoreBatchTask({ ...task, configJson: JSON.parse(task.configJson), caseStatesJson: JSON.parse(task.caseStatesJson), traceEvalStatesJson: { upload: { taskId: 'one', status: 'done', score: 999 }, foreign: { taskId: 'outside', status: 'done', score: 999 } } }); assert.equal(result.traceEvalStatesJson.upload.score, 80); assert.equal(result.traceEvalStatesJson.foreign.score, undefined); assert.equal(result.traceEvalStatesJson.foreign.status, 'idle'); });
test('PATCH cannot supply an internal backing Experiment identity', () => { const { api } = setup(); const result = api.preserveCoreBatchBindings({}, { sourceMode: 'trace', evalExperimentId: 'foreign' }); assert.equal(result.evalExperimentId, undefined); });
test('lost final static update reuses the persisted durable start key on retry', async () => { const { api, task, prisma, context } = setup(); let writes = 0; const update = prisma.batchEvalTask.updateMany; prisma.batchEvalTask.updateMany = async (input: Parameters<typeof update>[0]) => { writes++; if (writes === 2)
    throw new Error('static update unavailable'); return update(input); }; await assert.rejects(() => api.startCoreBatchTrace(task, ['one']), /static update unavailable/); const first = JSON.parse(task.configJson).coreTraceOperation.key; context.operationKey = 'next-http'; await api.startCoreBatchTrace(task, ['one']); assert.equal(JSON.parse(task.configJson).coreTraceOperation.key, first); });
test('0 machine score remains pass and completed sibling keeps its score on retry', async () => { const { api, task, exp } = setup(); exp.cases[0].results[0].score = 0; await api.startCoreBatchTrace(task, ['one'], true); const result = await api.projectCoreBatchTask({ ...task, configJson: JSON.parse(task.configJson), caseStatesJson: JSON.parse(task.caseStatesJson), traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson) }); assert.equal(result.caseStatesJson.one.status, 'pass'); assert.equal(result.caseStatesJson.one.score, 0); assert.equal(result.caseStatesJson.two.score, 76); });
test('shared source owned by another principal is rejected before binding', async () => { const { api, task, context, calls } = setup(); context.actor.principal = 'someone-else'; await assert.rejects(() => api.startCoreBatchTrace(task, ['one']), { status: 403 }); assert.ok(!calls.includes('ensure')); });
test('concurrent different Trace selection conflicts before starting another model generation', async () => { const { api, task, config, exp, calls } = setup(); config.coreTraceOperation = { key: 'running', caseIds: ['c2'], action: 'evaluate', phase: 'submitted' }; task.configJson = JSON.stringify(config); exp.cases[1].results[0].status = 'running'; await assert.rejects(() => api.startCoreBatchTrace(task, ['one'], true), { status: 409 }); assert.ok(!calls.includes('ensure')); });
test('current work timestamp replaces the original slot timestamp on single-case retry', async () => { const { api, task, exp } = setup(); exp.cases[0].results[0].createdAt = '2020-01-01T00:00:00Z'; exp.cases[0].results[0].coreWork = { createdAt: '2026-11-16T10:00:00Z', startedAt: '2026-11-16T10:00:01Z' }; exp.cases[0].results[1].coreWork = { createdAt: '2026-11-16T10:00:00Z', startedAt: '2026-11-16T10:00:02Z' }; const result = await api.projectCoreBatchTask({ ...task, configJson: JSON.parse(task.configJson), caseStatesJson: JSON.parse(task.caseStatesJson), traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson) }); assert.equal(result.caseStatesJson.one.startedAt, Date.parse('2026-11-16T10:00:00Z')); });
test('a racing static config write is preserved and never starts unbound work', async () => { const { api, task, prisma, calls } = setup(); prisma.batchEvalTask.updateMany = async () => ({ count: 0 }); await assert.rejects(() => api.startCoreBatchTrace(task, ['one']), { status: 409 }); assert.ok(!calls.some(value => value.startsWith('start:'))); });
test('compatibility legacy owner need not equal typed principal login', async () => { const { api, task, context, exp } = setup(); context.actor.username = 'legacy-owner'; task.user = 'legacy-owner'; const response = await api.projectCoreBatchTask({ ...task, configJson: JSON.parse(task.configJson), caseStatesJson: JSON.parse(task.caseStatesJson), traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson) }); assert.equal(response.caseStatesJson.one.score, 80); assert.equal(exp.user, 'trusted'); });
test('abort preserves already completed sibling results while failing only cancelled current work', async () => { const { api, task, exp } = setup(); exp.status = 'cancelled'; exp.cases[0].results[0].status = 'cancelled'; exp.cases[0].results[0].coreResult = null; const value = await api.projectCoreBatchTask({ ...task, configJson: JSON.parse(task.configJson), caseStatesJson: JSON.parse(task.caseStatesJson), traceEvalStatesJson: JSON.parse(task.traceEvalStatesJson) }); assert.equal(value.caseStatesJson.one.status, 'fail'); assert.equal(value.caseStatesJson.two.status, 'pass'); assert.equal(value.caseStatesJson.two.score, 76); });
test('abort followed by retry keeps the existing binding and completed sibling',async()=>{
 const {api,task,exp,calls}=setup();exp.status='cancelled';
 await api.startCoreBatchTrace(task,['one'],true);
 assert.ok(calls.includes('start:c1'));assert.ok(!calls.includes('ensure'));assert.ok(!calls.includes('case:one'));
});
test('abort followed by evaluate permits a new owned Trace on the same Experiment',async()=>{
 const {api,task,exp,calls}=setup();exp.status='cancelled';
 await api.startCoreBatchTrace(task,['three']);
 assert.ok(calls.includes('case:three'));assert.ok(calls.includes('start:c2'));assert.ok(!calls.includes('ensure'));
});

test('committed work receipt resumes after failed static acknowledgement without latest model configuration',async()=>{
 const {api,task,prisma,replay,calls,context}=setup();let writes=0;const update=prisma.batchEvalTask.updateMany;
 prisma.batchEvalTask.updateMany=async(input)=>{if(++writes===2)throw Error('static acknowledgement unavailable');return update(input);};
 await assert.rejects(()=>api.startCoreBatchTrace(task,['one']),/static acknowledgement unavailable/);
 replay.found=true;replay.latestUnavailable=true;context.operationKey='recovery';
 await api.startCoreBatchTrace(task,['one']);
 assert.equal(calls.filter(value=>value==='start:c1').length,1);assert.ok(calls.includes('activate'));
});
test('a new successful evaluate intent creates a new key after the prior intent is fully acknowledged',async()=>{
 const {api,task,context}=setup();await api.startCoreBatchTrace(task,['one']);context.operationKey='new-intent';
 await api.startCoreBatchTrace(task,['one']);assert.equal(JSON.parse(task.configJson).coreTraceOperation.key,'new-intent');
});
test('another active intent on the same selection retains the original already-running conflict',async()=>{
 const {api,task,exp,context}=setup();await api.startCoreBatchTrace(task,['one']);
 exp.cases[0].results[0].status='running';context.operationKey='another-intent';
 await assert.rejects(()=>api.startCoreBatchTrace(task,['one']),{status:409});
});
test('the same active intent resumes the persisted work key',async()=>{
 const {api,task,exp}=setup();await api.startCoreBatchTrace(task,['one']);exp.cases[0].results[0].status='running';
 await api.startCoreBatchTrace(task,['one']);assert.equal(JSON.parse(task.configJson).coreTraceOperation.key,'request');
});
test('collection create preserves the original raw JSON-string response and verified owner',async()=>{
 let context:{compatibilityRoute:boolean}|undefined;let owner='';
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{getCoreExperimentContext:()=>context},
  '@/lib/storage-core/workbench':{withCoreWorkbenchRoute:async(request:{json:()=>Promise<Record<string,unknown>>},next:(request:object)=>Promise<Response>)=>{context={compatibilityRoute:true};return next({json:async()=>({...await request.json(),user:'trusted'})});}},
  '@/lib/storage/prisma':{prisma:{batchEvalTask:{create:async({data}:{data:{user:string;taskName:string}})=>{owner=data.user;return {...data,id:'new',configJson:'{}',caseStatesJson:'{}',traceEvalStatesJson:'{}'};}}}},
  '@/lib/usage-analytics/collector':{recordUsageEvent:()=>{}},
  '@/lib/storage-core/batch-trace':{assertCoreBatchScope:async()=>{}},
 };
 const api=load<{POST:(request:object)=>Promise<Response>}>('src/app/api/debug/batch-tasks/route.ts',deps);
 const response=await api.POST({json:async()=>({user:'forged',taskName:'  old task  '})});assert.equal(response.status,200);
 const value=await response.json();assert.equal(owner,'trusted');assert.equal(value.configJson,'{}');assert.equal(value.taskName,'old task');
});
for(const conflict of [false,true])test('Trace PATCH uses CAS and typed flat progress, conflict='+conflict,async()=>{
 const {api:helper,task}=setup();let writes=0;
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/experiments':{getCoreExperimentContext:()=>({compatibilityRoute:true}),coreExperimentFailure:(error:{status:number})=>Response.json({error:'failure'},{status:error.status})},
  '@/lib/storage-core/batch-trace':helper,
  '@/lib/storage/prisma':{prisma:{batchEvalTask:{findFirst:async()=>task,findFirstOrThrow:async()=>task,update:async()=>{throw Error('unconditional static overwrite forbidden');},updateMany:async({where,data}:{where:{configJson:string;caseStatesJson:string};data:Partial<FixtureTask>})=>{writes++;assert.equal(where.configJson,task.configJson);assert.equal(where.caseStatesJson,task.caseStatesJson);if(conflict)return {count:0};Object.assign(task,data);return {count:1};}}}},
 };
 const api=load<{PATCH:(request:object,options:object)=>Promise<Response>}>('src/app/api/debug/batch-tasks/[taskId]/route.ts',deps);
 const response=await api.PATCH({json:async()=>({user:'trusted',caseStatesJson:{one:{status:'pass',score:999999}}})},{params:Promise.resolve({taskId:'batch'})});
 assert.equal(response.status,conflict?409:200);assert.equal(writes,1);
 if(!conflict){const value=await response.json();assert.equal(value.caseStatesJson.one.score,80);assert.equal(typeof value.configJson,'object');}
});
test('Dataset flat control state remains unchanged at this migration boundary',async()=>{
 const {api,task,config}=setup();config.sourceMode='dataset';
 const parsed={...task,configJson:config,caseStatesJson:JSON.parse(task.caseStatesJson),traceEvalStatesJson:{}};
 assert.deepEqual(await api.projectCoreBatchTask(parsed),parsed);
});
test('shared pure start identity preserves the existing operation key bytes and exact request',()=>{
 const assets=load<{coreExperimentStartOperation:(context:{operationKey:string},id:string,options:{caseIds:string[]})=>{key:string;request:object}}>('src/lib/storage-core/experiment-assets.ts',{'node:crypto':{createHash}});
 assert.equal(typeof assets.coreExperimentStartOperation,'function');
 const operation=assets.coreExperimentStartOperation({operationKey:'intent'},'exp',{caseIds:['c1','c2']});
 const suffix=createHash('sha256').update(JSON.stringify({case_ids:['c1','c2'],evaluator_ids:null})).digest('hex').slice(0,24);
 assert.equal(operation.key,'intent:start:'+suffix);
 assert.equal(JSON.stringify(operation.request),JSON.stringify({experiment_id:'exp',case_ids:['c1','c2'],evaluator_ids:null}));
});
test('Dataset PATCH retains its original configuration replacement boundary',async()=>{
 const {task,config}=setup();config.sourceMode='dataset';task.configJson=JSON.stringify(config);
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/experiments':{getCoreExperimentContext:()=>({compatibilityRoute:true}),coreExperimentFailure:()=>Response.json({error:'unexpected failure'},{status:502})},
  '@/lib/storage-core/batch-trace':{assertCoreBatchScope:async()=>{},preserveCoreBatchBindings:()=>{throw Error('Trace-only protection reached Dataset');},projectCoreBatchTask:async(value:object)=>value},
  '@/lib/storage/prisma':{prisma:{batchEvalTask:{findFirst:async()=>task,findFirstOrThrow:async()=>task,updateMany:async({data}:{data:Partial<FixtureTask>})=>{Object.assign(task,data);return {count:1};}}}},
 };
 const api=load<{PATCH:(request:object,options:object)=>Promise<Response>}>('src/app/api/debug/batch-tasks/[taskId]/route.ts',deps);
 const response=await api.PATCH({json:async()=>({user:'trusted',configJson:{sourceMode:'dataset',skillId:'changed',versionId:'changed-version'}})},{params:Promise.resolve({taskId:'batch'})});
 assert.equal(response.status,200);assert.equal((await response.json()).configJson.skillId,'changed');
});
test('read-only owner cannot start a Trace model or inspect Skill/config before the capability check',async()=>{
 const {api,task,scope,calls}=setup();scope.allowed=false;task.configJson='invalid config must remain unread';
 await assert.rejects(()=>api.startCoreBatchTrace(task,['one']),{status:403});assert.equal(calls.includes('ensure'),false);assert.equal(calls.some(value=>value.startsWith('evidence:')),false);
});
for(const [path,method] of [['src/app/api/debug/batch-tasks/route.ts','POST'],['src/app/api/debug/batch-tasks/[taskId]/route.ts','PATCH'],['src/app/api/debug/batch-tasks/[taskId]/route.ts','POST']])test('read-only same-principal Batch mutation is rejected before static control access: '+method+path,async()=>{
 let reads=0;let checks=0;
 const api=load<Record<string,(request:object,options:object)=>Promise<Response>>>(path,{
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/experiments':{getCoreExperimentContext:()=>({compatibilityRoute:true}),coreExperimentFailure:(error:{status:number})=>Response.json({error:'denied'},{status:error.status})},
  '@/lib/storage-core/batch-trace':{assertCoreBatchScope:async()=>{checks++;throw Object.assign(Error('read only'),{status:403});}},
  '@/lib/storage/prisma':{prisma:new Proxy({},{get(){reads++;throw Error('Static access preceded capability check');}})},
 });
 const response=await api[method]({json:async()=>({user:'trusted',taskName:'x',action:'evaluate',caseIds:['one'],configJson:{sourceMode:'trace'}})},{params:Promise.resolve({taskId:'batch'})});
 assert.equal(response.status,403);assert.equal(reads,0);assert.equal(checks,1);
});
test('cancelled current work exposes its real completion time and discards client completion claims',async()=>{
 const {api,task,exp}=setup();exp.status='cancelled';exp.cases[0].results[0].status='cancelled';exp.cases[0].results[0].coreResult=null;
 exp.cases[0].results[0].coreWork={createdAt:'2026-11-16T11:00:00Z',startedAt:'2026-11-16T11:00:01Z',finishedAt:'2026-11-16T11:00:02Z'};
 const value=await api.projectCoreBatchTask({...task,configJson:JSON.parse(task.configJson),caseStatesJson:{one:{status:'pass',completedAt:1}},traceEvalStatesJson:{}});
 assert.equal(value.caseStatesJson.one.status,'fail');assert.equal(value.caseStatesJson.one.completedAt,Date.parse('2026-11-16T11:00:02Z'));
});
test('verified deleted backing hides only that list task and detail returns the original 404',async()=>{
 const {api:helper,task,lifecycle,calls}=setup();lifecycle.state='deleted';
 const dataset={...task,id:'dataset-task',configJson:'{"sourceMode":"dataset"}'};
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{getCoreExperimentContext:()=>({compatibilityRoute:true})},
  '@/lib/storage-core/batch-trace':helper,
  '@/lib/storage/prisma':{prisma:{batchEvalTask:{findMany:async()=>[task,dataset],findFirst:async()=>task}}},
 };
 const list=load<{GET:(request:object)=>Promise<Response>}>('src/app/api/debug/batch-tasks/route.ts',deps);
 const response=await list.GET({url:'http://localhost/api/debug/batch-tasks?user=trusted'});assert.equal(response.status,200);
 const value=await response.json();assert.equal(value.length,1);assert.equal(value[0].id,'dataset-task');
 const detail=load<{GET:(request:object,options:object)=>Promise<Response>}>('src/app/api/debug/batch-tasks/[taskId]/route.ts',deps);
 assert.equal((await detail.GET({url:'http://localhost/api/debug/batch-tasks/batch?user=trusted'},{params:Promise.resolve({taskId:'batch'})})).status,404);
 assert.equal(calls.includes('read'),false);
});
