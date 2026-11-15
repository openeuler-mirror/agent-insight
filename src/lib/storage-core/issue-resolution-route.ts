import {prismaRaw} from '@/lib/storage/prisma';
import {createHash} from 'node:crypto';
import {getCoreExperimentContext,requireCoreExperimentContext,coreExperimentFailure} from './experiments';
import {resolutionCoreCandidates,resolveCoreDerivedIssues} from './derived-issues';
import {withCoreWorkbenchRoute} from './workbench';

function invalid(message:string,status=400):never{throw Object.assign(new Error(message),{status});}
export async function handleCoreIssueResolution(request:Request,rawName:string):Promise<Response>{
 try{
  if(!getCoreExperimentContext())return await withCoreWorkbenchRoute(request,input=>handleCoreIssueResolution(input,rawName));
  const context=requireCoreExperimentContext();let name:string;
  try{name=decodeURIComponent(rawName).trim();}catch{invalid('Invalid Skill name');}
  if(!name)invalid('Skill name required');
  const user=context.actor.username,body=context.body;
  const ids=Array.isArray(body.ids)?[...new Set(body.ids.filter((id):id is string=>typeof id==='string'&&id.length>0))].sort():[];
  if(!ids.length)invalid('Issue identities required');if(ids.length>2000||ids.some(id=>id.length>512))invalid('Issue identity budget exceeded',413);
  if(body.threadId!==undefined&&body.threadId!==null&&typeof body.threadId!=='string')invalid('Invalid resolution thread');
  const thread=typeof body.threadId==='string'&&body.threadId?body.threadId:null;
  if(thread&&(thread.length>512||!thread.trim()||/[\u0000-\u001f\u007f-\u009f]/.test(thread)))invalid('Invalid resolution thread');
  const authority=async()=>{const value=await context.rpc('derived_resolution_scope',{}) as {fingerprint?:unknown};if(typeof value?.fingerprint!=='string'||!value.fingerprint)invalid('Resolution authority unavailable',503);return value.fingerprint;};
  const fingerprint=await authority();
  const skills=await prismaRaw.skill.findMany({where:{name,OR:[{user},{user:null},{visibility:'public'}]},select:{id:true}});
  const scope={id:{in:ids},user,source:{in:['static','feedback']},Skill:{name}};
  const staticIssues=await prismaRaw.skillIssue.findMany({where:scope,select:{id:true}});
  const candidates=await resolutionCoreCandidates({user,ids,skillIds:skills.map(skill=>skill.id)});
  const staticIds=new Set(staticIssues.map(issue=>issue.id));
  if(candidates.some(issue=>staticIds.has(issue.id)))invalid('Issue identity is ambiguous across storage domains',409);
  const operationKey='optimization-point-resolution:'+createHash('sha256').update(context.operationKey).digest('hex');
  const resolved=candidates.length?await resolveCoreDerivedIssues({user,ids:candidates.map(issue=>issue.id),resolvedRunId:thread,operationKey}):{newly_resolved:0};
  let staticCount=0;
  if(staticIds.size){
   if(await authority()!==fingerprint)invalid('Resolution authority changed',403);
   staticCount=(await prismaRaw.skillIssue.updateMany({where:{...scope,id:{in:[...staticIds]},resolvedAt:null},data:{resolvedAt:new Date(),resolvedRunId:thread}})).count;
  }
  if(await authority()!==fingerprint)invalid('Resolution authority changed',403);
  return Response.json({resolvedCount:resolved.newly_resolved+staticCount});
 }catch(cause){return coreExperimentFailure(cause);}
}
