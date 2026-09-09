import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {prisma} from '../src/lib/storage/prisma';
import {demoCases} from '../src/lib/evaluation-harness/catalog';
import {buildDemoVersionView,expandVersionRuns,type VersionChoices} from '../src/lib/evaluation-harness/demo-versions';
import {caseRerunConfig} from '../src/lib/evaluation-harness/case-rerun';

async function main(){
 assert.match(process.env.DATABASE_URL||'',/harness-e2e/,'Only run against the isolated demo database');
 const base=process.env.AGENT_INSIGHT_URL||'http://127.0.0.1:3019',user='harness-ui@example.test';
 const account=await prisma.user.findUnique({where:{username:user}});assert(account?.apiKey,'Demo account must already exist');
 const headers={'content-type':'application/json','x-witty-api-key':account.apiKey};
 async function call(body?:unknown,query=''){
  const response=await fetch(base+'/api/evaluation-harness'+query,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(240000)});
  const data=await response.json();assert(response.ok,data.error||`HTTP ${response.status}`);return data;
 }
 const records:any[]=[];
 async function run(config:any){
  const {id}=await call({action:'create',config});await call({action:'run',id});
  for(let i=0;i<600;i++){
   const d=await call(undefined,'?experimentId='+id);
   if(!['draft','running'].includes(d.experiment.status)){
    assert.equal(d.experiment.status,'done',JSON.stringify(d.experiment.cases.map((c:any)=>c.traceGenerationError)));
    assert(d.experiment.cases.every((c:any)=>c.executionId));
    records.push({id,name:config.name,status:d.experiment.status,score:d.summary.score,cases:d.experiment.cases.length,traceIds:d.experiment.cases.map((c:any)=>c.executionId),groups:d.comparison?.groups.map((g:any)=>({key:g.key,score:g.summary.score,agentVersion:g.target.version,skillVersion:g.skill?.version,datasetVersion:g.dataset.version,evaluatorIds:g.evaluatorIds}))});
    console.log(`${config.name}: ${d.summary.score}% (${id})`);return d;
   }
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw Error('Experiment timed out');
 }
 await call({action:'bootstrap'});let catalog=await call();
 const asset=(key:string,v:number)=>{const result=catalog.assets.find((a:any)=>a.assetKey===key&&a.version===v&&!a.archived);assert(result,`${key} v${v} missing`);return result;};
 async function ensure(kind:string,key:string,name:string,content:any,version:number){
  const existing=catalog.assets.find((a:any)=>a.assetKey===key&&a.version===version);if(existing)return existing;
  const result=await call({action:'asset',kind,assetKey:key,name,content});catalog=await call();return result;
 }
 const agentA=catalog.assets.find((a:any)=>a.assetKey==='loan-agent'&&!a.archived&&a.content.behavior==='baseline'),agentB=catalog.assets.find((a:any)=>a.assetKey==='loan-agent'&&!a.archived&&a.content.behavior==='fixed');assert(agentA&&agentB);
 const skillA=catalog.assets.find((a:any)=>a.assetKey==='loan-skill'&&!a.archived&&a.content.behavior==='baseline'),skillB=catalog.assets.find((a:any)=>a.assetKey==='loan-skill'&&!a.archived&&a.content.behavior==='fixed');assert(skillA&&skillB);
 const dsA=await ensure('dataset','nh-demo-cases','演示 · 业务验收集',{cases:demoCases},1);
 const dsB=await ensure('dataset','nh-demo-cases','演示 · 业务验收集',{cases:[...demoCases,{id:'out-of-scope',name:'范围外请求兜底',category:'boundary',turns:[{input:'查询天气',expectation:{expectedSkill:'none',state:'out_of_scope',forbiddenTools:['approve_loan']}}]}]},2);
 const evalA=await ensure('evaluator','nh-demo-rules','演示 · 业务验收规则',{type:'rules',criticalStop:true},1);
 const evalB=await ensure('evaluator','nh-demo-rules','演示 · 业务验收规则',{type:'rules',criticalStop:false,checkNames:['路由']},2);
 const execution={endpoint:catalog.executionOptions.demoEndpoint,model:'demo-basic'};assert(execution.endpoint);
 const shared={targetId:agentA.id,skillId:skillA.id,datasetId:dsA.id,evaluatorIds:[evalA.id],execution,threshold:90,concurrency:2,timeoutSeconds:10,retries:0};
 const baseline=await run({...shared,name:`演示 · 基线验收（Skill v${skillA.version}）`});assert.equal(baseline.summary.score,50);
 const regression=await run({...shared,name:`演示 · 修复后回归（Skill v${skillB.version}）`,skillId:skillB.id,sourceExperimentId:baseline.experiment.id});assert.equal(regression.summary.score,100);
 for(const comparison of [{dimension:'agent',targetBId:agentB.id},{dimension:'skill',skillAId:skillA.id,skillBId:skillB.id},{dimension:'evaluator',evaluatorBIds:[evalB.id]},{dimension:'dataset',datasetBId:dsB.id}]){
  const d=await run({...shared,name:'演示 · '+({agent:'Agent',skill:'Skill',evaluator:'评估器',dataset:'评测集'} as any)[comparison.dimension]+' 版本对比',comparison});
  assert.equal(d.comparison.groups.length,2);
  assert.deepEqual(d.manifest.execution,execution);
  if(comparison.dimension==='evaluator')assert(d.comparison.pairs.every((p:any)=>p.a.executionId===p.b.executionId));
 }
 const single=await run({...caseRerunConfig(regression,regression.experiment.cases.find((c:any)=>JSON.parse(c.caseValuesJson).id==='loan-high').id,regression.experiment.id),name:'演示 · 单 Case 复验'});assert.equal(single.experiment.cases.length,1);
 const traceId=single.experiment.cases[0].executionId;
 const trace=await call(undefined,'?traceId='+traceId);assert.equal(trace.turns.length,2);assert(trace.turns[1].tools.some((t:any)=>t.name==='request_human_review'));
 assert.equal((await fetch(base+'/api/evaluation-harness?traceId='+traceId)).status,401);
 const staticReport=JSON.parse((await call({action:'static',targetId:agentA.id})).reportJson);assert(Array.isArray(staticReport.findings));
 const revisedCase={...regression.results[0].case,note:'根据实际执行证据补充回归说明'};
 const revised=await call({action:'revise',experimentId:regression.experiment.id,caseId:regression.experiment.cases[0].id,case:revisedCase});
 assert(revised.version>dsB.version);
 const old=await call(undefined,'?experimentId='+baseline.experiment.id);assert.equal(old.manifest.dataset.id,dsA.id);
 catalog=await call();
 const choices:VersionChoices=Object.fromEntries(['agent','skill','evaluator','dataset'].map(k=>{const a=k==='agent'?agentA:k==='skill'?skillA:k==='evaluator'?evalA:dsA;return[k,{assetKey:a.assetKey,id:a.id,vary:k==='agent'}];})) as VersionChoices;
 const trends:any={};for(const kind of ['agent','skill','evaluator','dataset'] as const){const view=buildDemoVersionView(catalog.runs,{...choices,[kind]:{...choices[kind],vary:true}});assert(view.rows.length>=2);assert(view.series.some(s=>s.points.length>=2),kind+' trend must contain at least two versions');trends[kind]={records:view.rows.length,points:view.series.flatMap(s=>s.points.map(p=>({id:p.runId,versions:Object.fromEntries(Object.entries(p.assets).map(([k,v]:any)=>[k,v?.version])),score:p.score})))};}
 const llm:any={configured:catalog.executionOptions.publicModelConfigured,verified:false};
 if(llm.configured){
  const generated=await call({action:'generate',targetId:agentB.id});assert(generated.cases.length>=4&&generated.cases.length<=8);assert(generated.cases.some((c:any)=>c.turns.length>1));assert.equal(new Set(generated.cases.map((c:any)=>c.category)).size,3);llm.generatedCases=generated.cases.length;llm.model=catalog.executionOptions.publicModel;
  const judge=asset('semantic-judge',1);const d=await run({...shared,name:'演示 · 真实 LLM 评分',skillId:skillB.id,caseIds:['loan-high'],evaluatorIds:[evalA.id,judge.id]});
  const judged=d.experiment.cases.flatMap((c:any)=>c.results).filter((r:any)=>r.evaluatorId===judge.id);assert(judged.length&&judged.every((r:any)=>r.status==='done'&&typeof r.score==='number'));llm.verified=true;llm.experimentId=d.experiment.id;
 }
 const output={date:new Date().toISOString(),user,base,execution,records,staticFindings:staticReport.findings.length,trace:{traceId,turns:trace.turns.length,tool:trace.turns[1].tools[0].name},trends,llm,browser:'HTTP script does not verify browser; see report.md for separate UI evidence'};
 await writeFile('docs/design/evaluation-harness-v1/test-report/nh-demo-http-evidence.json',JSON.stringify(output,null,2)+'\n');
 console.log('HTTP flow, Trace, revision, regression and all four version trends verified; LLM:',llm.verified?'verified':'pending model connection');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>prisma.$disconnect());
