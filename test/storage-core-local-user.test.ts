import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require=createRequire(import.meta.url);
function fixture(created=false,conflict=false){
 let trusted=false,updates=0,seeds=0;
 const user={id:'original-user',username:'alice',apiKey:'api_fixture',externalAccount:null,_created:created};
 const dependencies:Record<string,unknown>={
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},
  '@/lib/storage-core/control-auth':{bootstrapCoreControlUser:async()=>user},
  '@/lib/storage-core/control-context':{withCoreControlRequest:async(request:Request,action:()=>Promise<unknown>)=>{assert.equal(request.headers.get('authorization'),'Bearer '+user.apiKey);trusted=true;try{return await action();}finally{trusted=false;}}},
  '@/lib/storage/prisma':{db:{findUserByExternalAccount:async()=>{assert.ok(trusted);return conflict?{username:'bob'}:null;},updateUserExternalAccount:async(username:string,externalAccount:string)=>{assert.ok(trusted);assert.equal(username,'alice');updates++;return {...user,externalAccount};}}},
  '@/server/builtin-example/seed':{seedBuiltinExampleForUser:async()=>{assert.ok(trusted);seeds++;}},
 };
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/auth/local-user.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{module,exports:module.exports,require:(name:string)=>dependencies[name]??require(name),Request});
 const api=module.exports as {findOrCreateLocalUser:(name:string,external?:string)=>Promise<any>};
 return {api,counts:()=>({updates,seeds})};
}
test('core existing local user persists the verified external account inside its actual scope',async()=>{
 const f=fixture();const user=await f.api.findOrCreateLocalUser('alice','verified-account');
 assert.equal(user.id,'original-user');assert.equal(user.externalAccount,'verified-account');assert.deepEqual(f.counts(),{updates:1,seeds:0});
});
test('core new user skips demo injection and refuses another user external account',async()=>{
 const fresh=fixture(true);await fresh.api.findOrCreateLocalUser('alice','verified-account');assert.deepEqual(fresh.counts(),{updates:1,seeds:0});
 const conflict=fixture(true,true);await assert.rejects(conflict.api.findOrCreateLocalUser('alice','verified-account'),/already linked/);assert.deepEqual(conflict.counts(),{updates:0,seeds:0});
});
