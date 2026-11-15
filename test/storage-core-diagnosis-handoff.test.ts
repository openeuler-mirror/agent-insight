import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
function load(){const module={exports:{}};let legacyReads=0;const calls:string[]=[];const snapshot={schemaVersion:1,experiment:{id:'e'},case:{id:'c'},execution:{id:'x'},interactions:[],skills:[],results:[]};const run={id:'d',status:'done',input_hash:'h',snapshot,report:{findings:[],issues:[]},execution_id:'x',createdAt:'date'};const old=new Proxy({}, {get(){legacyReads++;throw Error('Legacy diagnosis storage accessed');}});
 const deps:Record<string,unknown>={
 '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
 '@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>({actor:{username:'trusted'}})},
 '@/lib/storage-core/diagnosis-consumer':{buildCoreDiagnosisSnapshot:async()=>{calls.push('preview');return snapshot;},coreDiagnosisSnapshotHash:()=> 'h',submitCoreDiagnosis:async()=>{calls.push('submit');return run;},readCoreDiagnosis:async()=>{calls.push('read');return run;},freezeCoreTraceReport:async()=>{calls.push('freeze');return {runId:'d'};},verifyCoreDiagnosisSource:async()=>{calls.push('verify');return {valid:true};}},
 '@/lib/storage/prisma':{prismaRaw:old},
 '@/lib/engine/agent-debug/types':{AGENT_DEBUG_GENERATOR:'g'},
 '@/lib/engine/agent-debug/progress-store':{readDiagnosisProgress:()=>null},
 './contracts':{contentHash:()=> 'old-hash',parseStored:(x:string,y:unknown)=>x?JSON.parse(x):y,optimizationEligibility:()=>null,DiagnosisError:class extends Error{}},
 };
 vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/diagnosis/service.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,console,Buffer,Date,JSON,Set,require:(name:string)=>deps[name]||{}});return {api:module.exports as Record<string,Function>,snapshot,run,calls,get legacyReads(){return legacyReads;}};}
test('original Diagnosis service uses authoritative frozen source and preserves preview/read DTO in core scope',async()=>{const f=load();assert.equal(await f.api.buildSnapshot('forged','e','c',['r']),f.snapshot);assert.equal(f.api.previewSnapshot(f.snapshot).inputHash,'h');const run=await f.api.submitDiagnosis('forged',f.snapshot,{requestKey:'k',expectedInputHash:'h'});assert.equal(run.id,'d');const dto=await f.api.getDiagnosis('forged','d');assert.equal(dto.inputHash,'h');assert.equal(dto.id,'d');assert.equal(f.legacyReads,0);assert.deepEqual(f.calls,['preview','submit','read']);});
test('Trace report handoff uses core report freeze instead of old report or DiagnosisRun rows',async()=>{const f=load();assert.deepEqual(JSON.parse(JSON.stringify(await f.api.freezeTraceReport('forged','x','date'))),{runId:'d'});assert.equal(f.legacyReads,0);assert.deepEqual(f.calls,['freeze']);});

test('metadata-only DiagnosisRun access does not expose or attempt to render private snapshots',async()=>{const f=load();f.run.snapshot=null as any;await assert.rejects(f.api.getDiagnosis('forged','d'),/仅原创建者/);assert.equal(f.legacyReads,0);});
