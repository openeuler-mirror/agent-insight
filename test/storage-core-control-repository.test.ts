import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {withCoreControlRequest} from '../src/lib/storage-core/control-context';
import {controlClient} from '../src/lib/storage-core/control-repository';
test('fixed control facade bounds selected Skill bodies and commits original multirow controls atomically',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'control-repository-'));process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:49019';process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=path.join(directory,'controller');await writeFile(process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE,'a'.repeat(64),{mode:0o600});
 const calls:any[]=[];const records:any={skill:[{id:'s1',name:'one',user:'alice'},{id:'s2',name:'two',user:'alice'}],skillVersion:[{id:'v1',skillId:'s1',version:0,content:'selected'},{id:'v2',skillId:'s2',version:0,content:'do-not-load'}],userSettings:[]};
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));if(url.pathname==='/v1/auth/me')return Response.json({principal_id:'alice-id',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const body=JSON.parse(String(init?.body));calls.push(body);assert.equal(typeof (init?.headers as Record<string,string>)['x-storage-controller-proof'],'string');
  if(body.action==='records_batch')return Response.json({value:{results:body.operations.map((operation:any)=>operation.data),scope_revision:'1'}});
  const source=(records[body.kind]||[]).filter((row:any)=>(!body.ids||body.ids.includes(row.id))&&Object.entries(body.metadata||{}).every(([key,value])=>Array.isArray(value)?value.includes(row[key]):row[key]===value));
  return Response.json({value:{scope_revision:'0',rows:source.map((row:any)=>({record_id:row.id,revision:'1',owner_principal_id:'alice-id',data:Object.fromEntries(Object.entries(row).filter(([key])=>key!=='content'||body.fields?.includes(key)))}))}});
 };
 await withCoreControlRequest(new Request('http://localhost/skills?workspace_id=w',{headers:{authorization:'Bearer api_'+'a'.repeat(43)}}),async()=>{
  const skill=await controlClient.skill.findUnique({where:{id:'s1'},include:{versions:{orderBy:{version:'desc'}}}});assert.equal(skill.versions[0].content,'selected');
  assert.ok(calls.filter(call=>call.kind==='skillVersion'&&call.fields?.includes('content')).every(call=>call.ids.length===1&&call.ids[0]==='v1'));
  const value=await controlClient.$transaction(async(tx:any)=>{const settings=await tx.userSettings.upsert({where:{user:'alice'},create:{user:'alice',settingsJson:'{}'},update:{settingsJson:'{}'}});await tx.userSettings.update({where:{id:settings.id},data:{settingsJson:'{"autoEvaluationEnabled":true}'}});return settings.id;});
  assert.equal(typeof value,'string');const batches=calls.filter(call=>call.action==='records_batch');assert.equal(batches.length,1);assert.equal(batches[0].operations.length,1);assert.equal(batches[0].operations[0].method,'create');assert.match(batches[0].operations[0].data.settingsJson,/true/);
 },{fetcher});
 const count=await withCoreControlRequest(new Request('http://localhost/skills?workspace_id=w',{headers:{authorization:'Bearer api_'+'a'.repeat(43)}}),()=>controlClient.skill.count(),{fetcher});
 assert.equal(count,2);
});

test('mutation DTOs use committed timestamps without expanding selected fields',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'control-commit-'));
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:49020';
 process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=path.join(directory,'controller');
 await writeFile(process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE,'b'.repeat(64),{mode:0o600});
 const committedAt='2026-11-20T00:00:00.000Z';
 const fetcher:typeof fetch=async(input,init)=>{
  if(new URL(String(input)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const body=JSON.parse(String(init?.body));
  if(body.action==='records_read')return Response.json({value:{scope_revision:'0',rows:[]}});
  assert.equal(body.action,'records_batch');
  return Response.json({value:{results:body.operations.map((operation:any)=>({...operation.data,updatedAt:committedAt})),scope_revision:'1'}});
 };
 await withCoreControlRequest(new Request('http://localhost/control',{headers:{authorization:'Bearer api_'+'b'.repeat(43)}}),async()=>{
  const record=await controlClient.skillTriggerEvalSet.create({data:{user:'alice',skillName:'checking',version:1,itemsJson:'[]'},select:{updatedAt:true}});
  assert.deepEqual(Object.keys(record),['updatedAt']);assert.equal(record.updatedAt.toISOString(),committedAt);
  const nested=await controlClient.$transaction(async(tx:any)=>({record:await tx.userSettings.create({data:{user:'alice',settingsJson:'{}'},select:{id:true,updatedAt:true}})}));
  assert.equal(nested.record.updatedAt.toISOString(),committedAt);assert.deepEqual(Object.keys(nested.record).sort(),['id','updatedAt']);
 },{fetcher});
});
