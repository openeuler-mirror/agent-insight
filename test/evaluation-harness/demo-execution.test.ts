import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {prisma} from '../../src/lib/storage/prisma';
import {createAsset} from '../../src/lib/evaluation-harness/store';
import {createRun,executeRun} from '../../src/lib/evaluation-harness/service';
import {caseRerunConfig} from '../../src/lib/evaluation-harness/case-rerun';
const user='nh-execution-'+randomUUID();
test.after(async()=>{
 await prisma.experiment.deleteMany({where:{user}});await prisma.evaluationAnalysis.deleteMany({where:{user}});
 await prisma.execution.deleteMany({where:{user}});await prisma.session.deleteMany({where:{user}});await prisma.evaluationAssetVersion.deleteMany({where:{user}});
});
test('four-asset experiments freeze and actually send shared Skill, execution address and model for single and all comparisons',async()=>{
 const requests:any[]=[];
 const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const b=JSON.parse(body);requests.push(b);res.setHeader('content-type','application/json');res.end(JSON.stringify({output:'ok',targetVersion:b.targetVersion,model:b.model,loadedSkills:b.skillOverrides?.map((s:any)=>({skillId:s.skillId,skillVersion:s.skillVersion,definitionHash:s.definitionHash})),skill:'s',tools:[]}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  const agent=await createAsset(user,'target','agent','Agent',{type:'agent',adapter:'http',endpoint:'http://127.0.0.1:1',externalId:'a',externalVersion:'a1'});
  const agentB=await createAsset(user,'target','agent','Agent',{type:'agent',adapter:'http',endpoint:'http://127.0.0.1:1',externalId:'a',externalVersion:'a2',skills:[{name:'old',description:'overridden by shared Skill'}]});
  const skill=await createAsset(user,'target','skill','Skill',{type:'skill',adapter:'http',endpoint,externalId:'s',externalVersion:'s1',prompt:'first'});
  const skillB=await createAsset(user,'target','skill','Skill',{type:'skill',adapter:'http',endpoint,externalId:'s',externalVersion:'s2',prompt:'second'});
  const content={cases:[{id:'c',name:'Case',turns:[{input:'q',expectation:{contains:'ok'}}]}]};
  const dataset=await createAsset(user,'dataset','data','Data',content), datasetB=await createAsset(user,'dataset','data','Data',content);
  const evaluator=await createAsset(user,'evaluator','rules','Rules',{type:'rules'}), evaluatorB=await createAsset(user,'evaluator','rules','Rules',{type:'rules',checkNames:['文本包含']});
  const execution={endpoint,model:'requested-model'};
  for(const comparison of [undefined,{dimension:'agent',targetBId:agentB.id},{dimension:'skill',skillAId:skill.id,skillBId:skillB.id},{dimension:'dataset',datasetBId:datasetB.id},{dimension:'evaluator',evaluatorBIds:[evaluatorB.id]}]){
   requests.length=0;
   const id=await createRun(user,{name:'NH '+(comparison?.dimension||'single'),targetId:agent.id,skillId:skill.id,datasetId:dataset.id,evaluatorIds:[evaluator.id],execution,comparison,retries:0});
   const detail=await executeRun(user,id);
   assert.equal(detail.experiment.status,'done');assert.equal(detail.summary.score,100);
   assert.equal(detail.manifest.skill.id,skill.id);assert.deepEqual(detail.manifest.execution,execution);
   assert.equal(requests.length,comparison&&comparison.dimension!=='evaluator'?2:1);
   assert(requests.every(r=>r.model==='requested-model'&&r.skillOverrides.length===1));
   const versions=requests.map(r=>r.skillOverrides[0].skillVersion).sort();
   assert.deepEqual(versions,comparison?.dimension==='skill'?['s1','s2']:Array(requests.length).fill('s1'));
   assert.equal(detail.manifest.target.content.endpoint,'http://127.0.0.1:1');
   const rerun=caseRerunConfig(detail,detail.experiment.cases[0].id,id);
   assert.equal(rerun.skillId,skill.id);assert.deepEqual(rerun.execution,execution);
  }
  await assert.rejects(()=>createRun(user,{name:'invalid shared skill',targetId:agent.id,skillId:agent.id,datasetId:dataset.id,evaluatorIds:[evaluator.id],execution}),/Skill/);
  await assert.rejects(()=>createRun(user,{name:'invalid endpoint',targetId:agent.id,skillId:skill.id,datasetId:dataset.id,evaluatorIds:[evaluator.id],execution:{endpoint:'file:///tmp/no'}}),/地址/);
 }finally{server.close();}
});

test('address overrides cannot forward an Agent credential to a different execution service',async()=>{
 const agent=await createAsset(user,'target','credential-agent','Private Agent',{type:'agent',adapter:'http',endpoint:'https://agent.example.test/run',externalId:'private',externalVersion:'v1',credentialId:'bound-credential'});
 const dataset=await createAsset(user,'dataset','credential-data','Data',{cases:[{id:'c',name:'c',turns:[{input:'q'}]}]});
 const evaluator=await createAsset(user,'evaluator','credential-eval','Rules',{type:'rules'});
 const config={name:'credential binding',targetId:agent.id,datasetId:dataset.id,evaluatorIds:[evaluator.id]};
 await assert.rejects(()=>createRun(user,{...config,execution:{endpoint:'https://another.example.test/run',model:''}}),/凭证.*地址/);
 await createRun(user,{...config,execution:{endpoint:'https://agent.example.test/run',model:''}});
});
