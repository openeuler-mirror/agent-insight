import {createHash,createHmac} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import path from 'node:path';
const purposes=new Set(['experiment-cancellation/v1','experiment-frozen-assets/v1','experiment-background/v1','workbench-handoff/v1','workbench-verification/v1','experiment-execution/v1','benchmark-device/v1','trace-analytics/v1','collector-source/v1']);
function unavailable():never{throw Object.assign(new Error('Private storage controller credential unavailable'),{status:503});}
export async function readControllerKey(file=process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE):Promise<string>{
 if(!file||!path.isAbsolute(file))unavailable();
 try{
  const entry=await lstat(file);if(entry.isSymbolicLink())unavailable();
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await handle.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.size>1024)unavailable();const value=(await handle.readFile('utf8')).trim();if(!/^[a-f0-9]{64}$/.test(value))unavailable();return value;}finally{await handle.close();}
 }catch{unavailable();}
}
export function signControllerPayload(key:string,purpose:string,principal:string,workspace:string,body:string):string{
 if(!/^[a-f0-9]{64}$/.test(key)||!purposes.has(purpose)||[principal,workspace].some(value=>!value||value.length>512||value.includes('\0')))unavailable();
 const digest=createHash('sha256').update(body,'utf8').digest('hex');
 return createHmac('sha256',Buffer.from(key,'hex')).update([purpose,principal,workspace,digest].join('\0'),'utf8').digest('hex');
}
export async function controllerHeaders(actor:{principal:string;workspace:string},body:string,purpose:string):Promise<Record<string,string>>{
 return {'x-storage-controller-proof':signControllerPayload(await readControllerKey(),purpose,actor.principal,actor.workspace,body)};
}

export async function validateControllerSkillScope(username:string,config:Record<string,unknown>):Promise<void>{
 const ids=config.derived_skill_ids;if(!Array.isArray(ids)||ids.length>2000||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw Object.assign(new Error('Invalid frozen Skill scope'),{status:400});
 const versions=config.derived_skill_versions;if(!versions||typeof versions!=='object'||Array.isArray(versions))throw Object.assign(new Error('Frozen Skill versions required'),{status:400});
 const {prisma}=await import('@/lib/storage/prisma');const rows=await prisma.skill.findMany({where:{id:{in:ids as string[]},OR:[{user:username},{user:null}]},select:{id:true,versions:{select:{version:true}}}}) as Array<{id:string;versions:Array<{version:number}>}>;
 const allowed=new Map(rows.map(row=>[row.id,new Set(row.versions.map(version=>version.version))]));
 const publicId=config.derived_public_business_skill_id;
 if(publicId!==undefined){
  const scope=config.experiment_skill_scope as Record<string,unknown>|undefined;
  const source=scope?.preset==='trigger'?'trigger':scope?.preset==='use-case'||scope?.scope==='skill-case-analysis'?'dynamic':null;
  const selected=(versions as Record<string,unknown>)[String(publicId)];
  if(typeof publicId!=='string'||!ids.includes(publicId)||!scope||scope.skill_id!==publicId||typeof scope.skill_name!=='string'||!scope.skill_name||!Number.isSafeInteger(scope.version)||(scope.version as number)<0||typeof scope.scope!=='string'||scope.source!==source||!source||!Array.isArray(selected)||selected.length!==1||selected[0]!==scope.version)throw Object.assign(new Error('Public business Skill scope is invalid'),{status:400});
  const target=await prisma.skill.findFirst({where:{id:publicId,name:scope.skill_name,visibility:'public',versions:{some:{version:scope.version as number}}},select:{id:true}});
  if(!target)throw Object.assign(new Error('Public business Skill is not permitted'),{status:403});
  allowed.set(publicId,new Set([scope.version as number]));
 }
 for(const id of ids as string[]){const actual=allowed.get(id);const frozen=(versions as Record<string,unknown>)[id];if(!actual)throw Object.assign(new Error('Frozen Skill is not permitted'),{status:403});if(!Array.isArray(frozen)||!frozen.length||frozen.some(version=>!Number.isSafeInteger(version)||!actual.has(version)))throw Object.assign(new Error('Frozen Skill version is unavailable'),{status:409});}
}
