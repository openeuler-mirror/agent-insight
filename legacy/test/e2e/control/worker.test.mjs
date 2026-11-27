import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerArgs, validateReport, runQueuedJob, extractContainerReport } from './worker-core.mjs';

const job={caseIds:['001','002','003','004','005'],id:'f'.repeat(32),repository:'gyctl/agent-insight',pr:1,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),mode:'mock'};
test('container reports survive tmpfs teardown through a bounded final JSON record',()=>{
 assert.deepEqual(extractContainerReport('UT output\nE2E_REPORT_JSON:{"status":"BLOCKED"}\n'),{status:'BLOCKED'});
 assert.throws(()=>extractContainerReport('no report'),/missing/);
 assert.throws(()=>extractContainerReport('E2E_REPORT_JSON:{broken}\n'),/JSON/);
});
test('PR executor has no network, host credentials, Docker socket or privileged mode',()=>{
 const args=dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/test-checkout',output:'/tmp/test-output',job});
 assert.ok(args.includes('none'));assert.ok(args.includes('--log-driver=none'));assert.ok(args.includes('--read-only'));assert.ok(args.includes('--init'));assert.ok(args.includes('no-new-privileges'));
 assert.ok(args.includes('--cap-drop=ALL'));assert.ok(args.includes('--memory=7168m'));assert.ok(args.includes('--cpus=2'));
 assert.ok(!args.join(' ').includes('ATOMGIT_TOKEN'));assert.ok(!args.join(' ').includes('docker.sock'));
 assert.throws(()=>dockerArgs({image:'node:latest',checkout:'/tmp/a',output:'/tmp/b',job}),/digest/);
});
test('worker never promotes missing, stale, interrupted or partial reports to success',()=>{
 const result={selected:job.caseIds,mode:'mock',testedSha:job.headSha,runId:'pr-'+job.id,status:'PASS',npmTest:{status:'PASS',fullSuiteComplete:true,interrupted:false,observedSummary:{tests:1,pass:1,fail:0,skipped:0,cancelled:0,todo:0}},scenarios:Array.from({length:5},(_,i)=>({id:String(i+1).padStart(3,'0'),status:'PASS'})),endedAt:new Date().toISOString()};
 assert.throws(()=>validateReport(result,{job,testedSha:job.baseSha,exitCode:0}),/SHA/);
 assert.throws(()=>validateReport({...result,scenarios:[]},{job,testedSha:job.headSha,exitCode:0}),/five/);
 assert.throws(()=>validateReport(result,{job,testedSha:job.headSha,exitCode:1}),/exit/);
 assert.throws(()=>validateReport({...result,npmTest:{...result.npmTest,fullSuiteComplete:false}},{job,testedSha:job.headSha,exitCode:0}),/UT/);
 assert.throws(()=>validateReport(result,{job,testedSha:job.headSha,exitCode:0}),/stages/);
});
test('stale or closed PR is not executed and failed execution never publishes PASS',async()=>{
 let calls=0;const current={state:'open',head:{sha:job.baseSha},base:{sha:job.baseSha}};
 const result=await runQueuedJob(job,{readPull:async()=>current,execute:async()=>{calls++;},isCurrent:()=>true});
 assert.equal(result.state,'SUPERSEDED');assert.equal(calls,0);
 current.head.sha=job.headSha;
 const failure=await runQueuedJob(job,{readPull:async()=>current,execute:async()=>{throw Error('crashed');},isCurrent:()=>true});
 assert.equal(failure.state,'ERROR');assert.equal(failure.result.status,'BLOCKED');
});
test('initial PR API outage still produces a five-case blocked report',async()=>{
 const outcome=await runQueuedJob(job,{readPull:async()=>{throw Error('timeout');},isCurrent:()=>true,execute:async()=>assert.fail('must not execute')});
 assert.equal(outcome.state,'ERROR');assert.equal(outcome.result.status,'BLOCKED');assert.equal(outcome.result.scenarios.length,5);
});
test('real PR container only receives relay token and a dedicated persistent lane',()=>{
 const real={...job,mode:'real'};assert.throws(()=>dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/source',job:real}),/relay/);
 const args=dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/source',job:real,dependencyVolume:'agent-insight-e2e-deps-'+'c'.repeat(16),network:'agent-insight-e2e-test',stateDirectory:'/tmp/test-state',tokenFile:'/tmp/relay-token',lane:'pr'});
 assert.ok(args.includes('E2E_MODE=real'));assert.ok(args.includes('E2E_LANE=pr'));assert.ok(args.includes('agent-insight-e2e-test'));assert.ok(args.join(' ').includes('dst=/run/e2e-relay.key,readonly'));assert.ok(!args.join(' ').includes('deepseek-key'));assert.ok(args.join(' ').includes('dst=/state-seed,readonly'));
});

test('image dependencies are mounted read-only inside the Next workspace with isolated Prisma output',()=>{const args=dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/source',job,dependencyVolume:'agent-insight-e2e-deps-'+'c'.repeat(16)});assert.ok(args.join(' ').includes('dst=/work/node_modules,readonly'));assert.ok(args.includes('/work/node_modules/.prisma:rw,exec,uid=1000,gid=1000,size=256m'));});
test('bounded disk workspace replaces RAM-backed checkout without changing read-only dependencies',()=>{
 const args=dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/source',workspace:'/tmp/job/workspace',job});
 assert.ok(args.includes('type=bind,src=/tmp/job/workspace,dst=/work,readonly=false'));
 assert.ok(!args.some(a=>a.startsWith('/work:rw')));
 assert.ok(args.some(a=>a.includes('dst=/work/node_modules,readonly')));
});
test('active profile requires full UT and merged 003 stages; fault recovery stays unexecuted',async()=>{
 const {requiredStagesFor}=await import('../shared/core.mjs');const selected=['001','002','003','004'];const five={...job,caseIds:selected,profile:'core-five'};
 const report={mode:'mock',testedSha:job.headSha,runId:'pr-'+job.id,status:'PASS',selected,endedAt:new Date().toISOString(),npmTest:{status:'PASS',fullSuiteComplete:true,interrupted:false,observedSummary:{tests:1,pass:1,fail:0,skipped:0,cancelled:0,todo:0}},scenarios:[...selected.map(id=>({id,status:'PASS',stages:requiredStagesFor(id).map(id=>({id,status:'PASS'}))})),{id:'005',status:'NOT_RUN',stages:[]}]};
 assert.equal(validateReport(report,{job:five,testedSha:job.headSha,exitCode:0}).status,'PASS');
 assert.throws(()=>validateReport({...report,selected:['001']},{job:five,testedSha:job.headSha,exitCode:0}),/selection/);
 assert.throws(()=>validateReport({...report,scenarios:report.scenarios.map(s=>s.id==='005'?{...s,status:'PASS'}:s)},{job:five,testedSha:job.headSha,exitCode:0}),/excluded/);
 const args=dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/source',job:five});assert.ok(args.includes('E2E_PROFILE=core-five'));
});
test('completed real execution is preserved when freshness API temporarily fails',async()=>{
 let calls=0;const result={status:'FAIL',selected:['001','002','003','004','005']};const outcome=await runQueuedJob({...job,mode:'real'},{isCurrent:()=>true,readPull:async()=>{if(++calls===2)throw Error('network');return {state:'open',head:{sha:job.headSha},base:{sha:job.baseSha}};},execute:async()=>result});assert.equal(outcome.state,'COMPLETED');assert.equal(outcome.result,result);assert.equal(outcome.verificationPending,true);
});
test('trusted config controls container budgets and rejects report/config mismatches',async()=>{
 const {loadExecutionConfig,configSnapshot}=await import('../shared/config.mjs');const config=loadExecutionConfig({overrides:{mode:'mock',resources:{cpus:3,memoryMiB:8192},runUt:false}}),snapshot=configSnapshot(config),configured={...job,mode:config.mode,caseIds:config.cases,runUt:false,configHash:snapshot.hash};
 const args=dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/source',job:{...configured,mode:'mock'},executionConfig:{...config,mode:'mock'}});assert.ok(args.includes('--memory=8192m'));assert.ok(args.includes('--cpus=3'));assert.ok(args.includes('E2E_SKIP_UT=1'));assert.ok(args.some(v=>v.startsWith('E2E_EXECUTION_CONFIG=')));
 const report={mode:config.mode,runId:'pr-'+job.id,testedSha:job.headSha,endedAt:new Date().toISOString(),status:'FAIL',selected:config.cases,configuration:snapshot,scenarios:['001','002','003','004','005'].map(id=>({id,status:config.cases.includes(id)?'FAIL':'NOT_RUN',stages:[]}))};
 assert.doesNotThrow(()=>validateReport(report,{job:configured,testedSha:job.headSha,exitCode:1}));assert.throws(()=>validateReport({...report,configuration:{...snapshot,hash:'0'.repeat(64)}},{job:configured,testedSha:job.headSha,exitCode:1}),/config/i);
});
test('configuration mismatch is reported distinctly before any business execution',async()=>{
 const outcome=await runQueuedJob({...job,mode:'real'},{isCurrent:()=>true,readPull:async()=>({state:'open',head:{sha:job.headSha},base:{sha:job.baseSha}}),execute:async()=>{throw Object.assign(new Error('changed'),{code:'E2E_CONFIG_MISMATCH'});}});assert.equal(outcome.state,'ERROR');assert.equal(outcome.result.status,'BLOCKED');assert.match(outcome.result.scenarios[0].reason,/配置/);
});
test('mixed report cannot mislabel a real scenario as mock under the same configuration hash',async()=>{
 const {loadExecutionConfig,configSnapshot}=await import('../shared/config.mjs'),config=loadExecutionConfig(),snapshot=configSnapshot(config);
 const configured={...job,mode:'mixed',caseIds:config.cases,configHash:snapshot.hash};const report={runId:'pr-'+job.id,mode:'mixed',testedSha:job.headSha,endedAt:new Date().toISOString(),status:'FAIL',selected:config.cases,configuration:snapshot,scenarios:['001','002','003','004','005'].map(id=>({id,status:config.cases.includes(id)?'FAIL':'NOT_RUN',mode:config.cases.includes(id)?'mock':undefined,stages:[]}))};
 assert.throws(()=>validateReport(report,{job:configured,testedSha:job.headSha,exitCode:1}),/mode/i);report.scenarios[0].mode='real';assert.doesNotThrow(()=>validateReport(report,{job:configured,testedSha:job.headSha,exitCode:1}));
});

test('mock container has offline native client dependencies without any model credential or network',()=>{
 const args=dockerArgs({image:'sha256:'+'a'.repeat(64),checkout:'/tmp/source',harness:'/tmp/harness',job:{id:'mock-six',mode:'mock'}});
 assert.equal(args[args.indexOf('--network')+1],'none');
 assert.ok(args.includes('E2E_PREPARED_PLUGIN_DIR=/opt/ras-plugin'));
 assert.ok(args.includes('PIP_NO_INDEX=1'));
 assert.ok(!args.some(x=>x.includes('/run/e2e-relay.key')));
});

test('production build open-file allowance applies only inside the configured sandbox',async()=>{
 const {loadExecutionConfig}=await import('../shared/config.mjs'),config=loadExecutionConfig({overrides:{resources:{openFiles:16384}}});const args=dockerArgs({image:'sha256:'+'c'.repeat(64),checkout:'/tmp/source',job,executionConfig:config});const at=args.indexOf('--ulimit');assert.ok(at>=0);assert.equal(args[at+1],'nofile=16384:16384');assert.ok(!args.includes('--privileged'));
});
