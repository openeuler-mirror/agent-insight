import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const skill=(id:string,user:string|null,visibility='private')=>({id,name:id,user,visibility,versions:[{version:1}]});
const records=[skill('owner','alice'),skill('global',null),skill('public','bob','public'),skill('other-public','bob','public'),skill('private','bob')];
function load(){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/controller.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(name:string)=>name==='@/lib/storage/prisma'?{prisma:{skill:{findMany:async(query:any)=>records.filter(row=>query.where.id.in.includes(row.id)&&(row.user==='alice'||row.user===null)),findFirst:async(query:any)=>records.find(row=>row.id===query.where.id&&row.name===query.where.name&&row.visibility==='public'&&row.versions.some(version=>version.version===query.where.versions.some.version))||null}}}:{},Map,Set,JSON});return module.exports as {validateControllerSkillScope:(user:string,config:Record<string,unknown>)=>Promise<void>};}
const business={skill_id:'public',skill_name:'public',version:1,source:'dynamic',preset:'use-case',scope:'skill-workbench'};
const valid={derived_skill_ids:['owner','public'],derived_skill_versions:{owner:[1],public:[1]},derived_public_business_skill_id:'public',experiment_skill_scope:business};
test('controller grants one exact public business Skill while retaining ordinary owner/global scopes',async()=>{
 const api=load();await api.validateControllerSkillScope('alice',valid);await api.validateControllerSkillScope('alice',{derived_skill_ids:['owner','global'],derived_skill_versions:{owner:[1],global:[1]}});
});
test('a public name, extra IDs or a direct request cannot broaden the business-only public exception',async()=>{
 const api=load();const variants=[{...valid,experiment_skill_scope:{...business,skill_name:'forged'}},{...valid,experiment_skill_scope:{...business,source:'trigger'}},{...valid,experiment_skill_scope:{...business,version:2}},{...valid,derived_skill_ids:['public','other-public'],derived_skill_versions:{public:[1],'other-public':[1]}},{derived_skill_ids:['public'],derived_skill_versions:{public:[1]}},{...valid,derived_public_business_skill_id:undefined},{...valid,experiment_skill_scope:undefined}];
 for(const value of variants)await assert.rejects(api.validateControllerSkillScope('alice',value));
});
