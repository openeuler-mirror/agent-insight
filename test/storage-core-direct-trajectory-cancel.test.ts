import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('terminate-all cancels trusted actors own core runs before aborting local registry and avoids legacy scoring writes',async()=>{
 const calls:string[]=[];const context={compatibilityRoute:true,actor:{username:'alice'},operationKey:'terminate',rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push(action+':'+(payload.experiment_id||''));if(action==='read_view')return {coverage:'complete',snapshots:[{experiment:{id:'own',user:'alice',cases:[{directTrajectory:{status:'pending'},results:[]}]}},{experiment:{id:'foreign',user:'bob',cases:[{directTrajectory:{status:'running'},results:[]}]}}]};return {};}};
 const deps:Record<string,unknown>={'next/server':{NextResponse:Response},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{getCoreExperimentContext:()=>context,requireCoreExperimentContext:()=>context},'@/server/user_termination_registry':{markUserTerminated:(user:string)=>calls.push('mark:'+user)},'@/server/trajectory_eval_run_registry':{abortTrajectoryEvalRunsForUser:(user:string)=>{calls.push('abort:'+user);return 1;}},'@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager':{killOpencodeForUser:()=>0},'@/server/batch_eval_run_registry':{abortBatchRunsForUser:async()=>({abortedRuns:0,resetCases:0})},'@/lib/storage/prisma':{prismaRaw:new Proxy({},{get(){throw Error('legacy machine writes forbidden');}})}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/app/api/eval/terminate-all/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(name:string)=>deps[name]||{},console,Response,Date,JSON});
 const response=await (module.exports as Record<string,Function>).POST(new Request('http://localhost/api/eval/terminate-all',{method:'POST',body:'{"user":"forged"}'}));assert.equal(response.status,200);assert.equal((await response.json()).cancelledEvalRows,1);assert.ok(calls.indexOf('cancel:own')<calls.indexOf('abort:alice'));assert.ok(!calls.includes('cancel:foreign'));assert.ok(!calls.some(value=>value.includes('forged')));
});
