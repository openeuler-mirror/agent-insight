import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {executeTurn} from '../../src/lib/evaluation-harness/adapters';
import {skillOverrideFor,targetSchema} from '../../src/lib/evaluation-harness/domain';

test('Skill override uses Agent identity and carries a versioned content snapshot',async()=>{
 const received:any[]=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);received.push(body);
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({output:'ok',targetVersion:body.targetVersion,loadedSkills:body.skillOverrides?.map(({definition,...identity}:any)=>identity)}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  const agent=targetSchema.parse({type:'agent',adapter:'http',endpoint,externalId:'shared-agent',externalVersion:'agent-v1'});
  const skill=targetSchema.parse({type:'skill',adapter:'http',endpoint:'http://must-not-call',externalId:'review',externalVersion:'skill-v2',credentialId:'must-not-use',model:'must-not-use',prompt:'人工复核'});
  const override=skillOverrideFor({version:2,content:skill});
  const result=await executeTurn('test',agent,'申请',[],AbortSignal.timeout(3000),{runId:'r',caseId:'c',attemptId:'a',turn:1,skillOverrides:[override]});
  assert.equal(received[0].targetId,'shared-agent');assert.equal(received[0].agentId,'shared-agent');assert.equal(received[0].targetVersion,'agent-v1');
  assert.equal(received[0].skillOverrides[0].skillId,'review');assert.equal(received[0].skillOverrides[0].skillVersion,'skill-v2');
  assert.equal(received[0].skillOverrides[0].definition.prompt,'人工复核');
  assert.equal(received[0].skillOverrides[0].definition.endpoint,undefined);assert.equal(received[0].skillOverrides[0].definition.credentialId,undefined);
  assert.equal(result.loadedSkills?.[0].definitionHash,override.definitionHash);
 }finally{server.close();}
});

test('Skill execution cannot pass without exact loaded Skill confirmation',async()=>{
 let response:any={output:'looks good',targetVersion:'v1'};
 const server=http.createServer(async(req,res)=>{for await(const _chunk of req){}res.setHeader('content-type','application/json');res.end(JSON.stringify(response));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
  const agent=targetSchema.parse({type:'agent',adapter:'http',endpoint,externalId:'shared-agent',externalVersion:'v1'});
  const override=skillOverrideFor({version:2,content:targetSchema.parse({type:'skill',adapter:'demo',externalId:'review',prompt:'review'})});
  const execute=()=>executeTurn('test',agent,'申请',[],AbortSignal.timeout(3000),{runId:'r',caseId:'c',attemptId:'a',turn:1,skillOverrides:[override]});
  await assert.rejects(execute,/Skill/);
  for(const wrong of [{skillId:'other'},{skillVersion:'other'},{definitionHash:'wrong'}]){
   response={output:'ok',targetVersion:'v1',loadedSkills:[{...override,...wrong}]};
   await assert.rejects(execute,/Skill/);
  }
  response={output:'ok',loadedSkills:[override]};await assert.rejects(execute,/Agent/);
 }finally{server.close();}
});

test('Demo keeps one Agent and executes the selected loaded Skill version',async()=>{
 const {spawn}=await import('node:child_process');
 const {readFile}=await import('node:fs/promises');
 const path=await import('node:path');
 const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=(reservation.address() as any).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 const child=spawn(process.execPath,[path.resolve('examples/evaluation-harness/server.mjs')],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 try{
  await once(child.stdout!,'data');
  const definitions=JSON.parse(await readFile(path.resolve('examples/evaluation-harness/targets.json'),'utf8'));
  const base=definitions.find((t:any)=>t.assetKey==='loan-agent'&&t.version===1);
  const agent=targetSchema.parse({...base.content,adapter:'http',endpoint:`http://127.0.0.1:${port}`});
  const output=[];
  for(const version of [1,2]){
   const source=definitions.find((t:any)=>t.assetKey==='loan-skill'&&t.version===version);
   const override=skillOverrideFor({version,content:targetSchema.parse(source.content)});
   output.push(await executeTurn('test',agent,'申请 8 万元，风险高',[],AbortSignal.timeout(3000),{runId:'r',caseId:'c',attemptId:String(version),turn:1,skillOverrides:[override]}));
  }
  assert.deepEqual(output.map(t=>t.state),['pending_review','approved']);
  assert(output.every(t=>t.targetVersion==='baseline'));
  assert.deepEqual(output.map(t=>t.loadedSkills?.[0].skillVersion),['fixed','baseline']);
 }finally{child.kill();await once(child,'exit');}
});
