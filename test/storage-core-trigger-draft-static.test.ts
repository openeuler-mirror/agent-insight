import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prismaRaw as prisma} from '@/lib/storage/prisma';
import {createTriggerEvalSetVersion,compareAndSetCoreTriggerDraft,replaceTriggerEvalItemsById,deletePlaceholderDraftingSets,deleteTriggerEvalSet,listTriggerEvalSetVersions} from '@/server/skill_trigger_eval_storage';
test.after(async()=>{await prisma.$disconnect();database.dispose();});
const items=[{id:'one',query:'first',shouldTrigger:true,source:'llm-draft' as const},{id:'two',query:'second',shouldTrigger:false,source:'llm-draft' as const}];

test('exact draft CAS recovers a lost ACK and never overwrites a user edit or recreates a deleted placeholder',async()=>{
 const ready=await createTriggerEvalSetVersion({user:'legacy-alice',skillName:'checking',items,versionSource:'manual'});
 const placeholder=await createTriggerEvalSetVersion({id:'operation-stable-placeholder',user:'legacy-alice',skillName:'checking',items:[],versionSource:'llm-draft',status:'drafting'});
 const output={status:'ready' as const,items,draftedFromSkillHash:'frozen-hash',versionNote:null};
 assert.equal((await compareAndSetCoreTriggerDraft(placeholder,output))?.id,placeholder.id);
 assert.equal((await compareAndSetCoreTriggerDraft(placeholder,output))?.version,2);assert.equal(await prisma.skillTriggerEvalSet.count(),2);
 const edited=await createTriggerEvalSetVersion({user:'legacy-alice',skillName:'checking',items:[],versionSource:'llm-draft',status:'drafting'});
 await replaceTriggerEvalItemsById(edited.id,[{id:'user-edited',query:'keep my edit',shouldTrigger:false,source:'user-edited'}]);
 await assert.rejects(compareAndSetCoreTriggerDraft(edited,output),(error:unknown)=>(error as {status:number}).status===409);
 assert.ok((await listTriggerEvalSetVersions('legacy-alice','checking')).find(row=>row.id===edited.id)?.items.some(row=>row.query==='keep my edit'));
 await deletePlaceholderDraftingSets('legacy-alice','checking');assert.equal(await prisma.skillTriggerEvalSet.count(),2);assert.ok((await listTriggerEvalSetVersions('legacy-alice','checking')).some(row=>row.id===ready.id));
 await deleteTriggerEvalSet('legacy-alice','checking');assert.equal(await compareAndSetCoreTriggerDraft(edited,output),null);assert.equal(await prisma.skillTriggerEvalSet.count(),0);
});

test('Python canonical JSON roundtrip replays actual Prisma ready CAS without losing rationale or edit protection',async()=>{
 const {execFileSync}=await import('node:child_process');
 const source=[{id:'positive',query:'first 中文',shouldTrigger:true,rationale:'保留原测试理由',source:'llm-draft' as const},{id:'negative',query:'second',shouldTrigger:false,source:'llm-draft' as const}];
 const canonical=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c','import json,sys;print(json.dumps(json.load(sys.stdin),ensure_ascii=False,sort_keys=True,separators=(",",":")))'],{input:JSON.stringify(source),encoding:'utf8'}));
 assert.notEqual(JSON.stringify(source),JSON.stringify(canonical));
 const placeholder=await createTriggerEvalSetVersion({id:'canonical-placeholder',user:'canonical-alice',skillName:'canonical-checking',items:[],versionSource:'llm-draft',description:'original metadata',versionNote:null,status:'drafting'});
 const output={status:'ready' as const,items:canonical,draftedFromSkillHash:'canonical-source-hash',versionNote:null};
 assert.equal((await compareAndSetCoreTriggerDraft(placeholder,output))?.status,'ready');
 assert.equal((await compareAndSetCoreTriggerDraft(placeholder,output))?.status,'ready');
 const original=await prisma.skillTriggerEvalSet.findUniqueOrThrow({where:{id:placeholder.id}});
 const edits=[(value:typeof source)=>{value[0].query='changed query';},(value:typeof source)=>{value[0].shouldTrigger=false;},(value:typeof source)=>{value[0].rationale='changed rationale';},(value:typeof source)=>{(value[0] as unknown as Record<string,unknown>).rationale=null;},(value:typeof source)=>{(value[1] as unknown as Record<string,unknown>).shouldTrigger=0;},(value:typeof source)=>{(value[0] as unknown as Record<string,unknown>).source='user-edited';},(value:typeof source)=>{value.reverse();},(value:typeof source)=>{value[0].query=' '+value[0].query;},(value:typeof source)=>{(value[0] as unknown as Record<string,unknown>).extension={present:null};}];
 for(const edit of edits){const changed=structuredClone(source);edit(changed);await prisma.skillTriggerEvalSet.update({where:{id:placeholder.id},data:{itemsJson:JSON.stringify(changed)}});const before=await prisma.skillTriggerEvalSet.findUniqueOrThrow({where:{id:placeholder.id}});await assert.rejects(compareAndSetCoreTriggerDraft(placeholder,output),(error:unknown)=>(error as {status:number}).status===409);assert.deepEqual(await prisma.skillTriggerEvalSet.findUniqueOrThrow({where:{id:placeholder.id}}),before);}
 await prisma.skillTriggerEvalSet.update({where:{id:placeholder.id},data:{itemsJson:original.itemsJson}});
 for(const data of [{user:'changed-owner'},{version:99},{versionNote:''},{draftedFromSkillHash:'changed-hash'}]){
  await prisma.skillTriggerEvalSet.update({where:{id:placeholder.id},data});const before=await prisma.skillTriggerEvalSet.findUniqueOrThrow({where:{id:placeholder.id}});await assert.rejects(compareAndSetCoreTriggerDraft(placeholder,output),(error:unknown)=>(error as {status:number}).status===409);assert.deepEqual(await prisma.skillTriggerEvalSet.findUniqueOrThrow({where:{id:placeholder.id}}),before);await prisma.skillTriggerEvalSet.update({where:{id:placeholder.id},data:{user:original.user,version:original.version,description:original.description,versionSource:original.versionSource,versionNote:original.versionNote,draftedFromSkillHash:original.draftedFromSkillHash}});
 }
 const metadataPlaceholder=await createTriggerEvalSetVersion({user:'metadata-alice',skillName:'metadata-checking',items:[],versionSource:'llm-draft',description:'original',status:'drafting'});
 for(const data of [{description:'changed metadata'},{versionSource:'manual'}]){
  await prisma.skillTriggerEvalSet.update({where:{id:metadataPlaceholder.id},data});const before=await prisma.skillTriggerEvalSet.findUniqueOrThrow({where:{id:metadataPlaceholder.id}});await assert.rejects(compareAndSetCoreTriggerDraft(metadataPlaceholder,output),(error:unknown)=>(error as {status:number}).status===409);assert.deepEqual(await prisma.skillTriggerEvalSet.findUniqueOrThrow({where:{id:metadataPlaceholder.id}}),before);await prisma.skillTriggerEvalSet.update({where:{id:metadataPlaceholder.id},data:{description:metadataPlaceholder.description,versionSource:metadataPlaceholder.versionSource,updatedAt:new Date(metadataPlaceholder.updatedAt)}});
 }

});
