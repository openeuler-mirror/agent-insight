import {AsyncLocalStorage} from 'node:async_hooks';

type Row=Record<string,unknown>;
export interface FrozenSkillRecord extends Row {id:string;name:string;user:string|null;activeVersion:number|null;versions:Row[];parsedFlows:Row[]}
type Reader={findSkill(name:string,user:string|null):Promise<unknown>;findSkillById(id:string):Promise<unknown>;findSkillVersion(id:string,version:number):Promise<unknown>;findParsedFlow(id:string,version:number,user:string|null):Promise<unknown>};
const contexts=new AsyncLocalStorage<{skills:FrozenSkillRecord[];user:string;flows:Map<string,Row>}>();
const key=(id:string,version:number,user:string|null)=>JSON.stringify([id,version,user]);
export const hasFrozenSkillCatalog=()=>contexts.getStore()!==undefined;
export function withFrozenSkillCatalog<T>(skills:FrozenSkillRecord[],user:string,action:()=>Promise<T>):Promise<T>{
 if(!Array.isArray(skills)||skills.some(skill=>!skill||typeof skill.id!=='string'||typeof skill.name!=='string'||!Array.isArray(skill.versions)||!Array.isArray(skill.parsedFlows)))throw Object.assign(new Error('Frozen Skill catalog is incomplete'),{status:503});
 return contexts.run({skills:structuredClone(skills),user,flows:new Map()},action);
}
export function rememberFrozenSkillFlow(value:{skillId:string;version:number;user:string|null;flowJson:string;mermaidCode:string}):void{
 const context=contexts.getStore();if(!context)throw Object.assign(new Error('Frozen Skill catalog scope required'),{status:503});
 if(value.user!==context.user||!context.skills.some(skill=>skill.id===value.skillId&&skill.versions.some(row=>row.version===value.version)))throw Object.assign(new Error('Parsed Skill flow is outside frozen scope'),{status:403});
 context.flows.set(key(value.skillId,value.version,value.user),structuredClone(value));
}
export function frozenSkillReadSource<T extends Reader>(legacy:T):T{
 const context=contexts.getStore();if(!context)return legacy;
 const own=(id:string)=>context.skills.find(skill=>skill.id===id&&(skill.user===context.user||skill.user===null));
 const source={
  findSkill:async(name:string,user:string|null)=>{if(user!==context.user)return null;return structuredClone(context.skills.find(skill=>skill.user===user&&skill.name.toLowerCase()===name.toLowerCase())||null);},
  findSkillById:async(id:string)=>structuredClone(own(id)||null),
  findSkillVersion:async(id:string,version:number)=>structuredClone(own(id)?.versions.find(row=>row.version===version)||null),
  findParsedFlow:async(id:string,version:number,user:string|null)=>{if(user!==context.user)return null;return structuredClone(context.flows.get(key(id,version,user))||own(id)?.parsedFlows.find(row=>row.version===version&&row.user===user)||null);},
 };
 return source as unknown as T;
}
