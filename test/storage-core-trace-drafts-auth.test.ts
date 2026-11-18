import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {activateIsolatedHome} from './helpers/isolated-home';
test('Trace draft authentication returns public 401 without constructing evidence or using a body username',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'trace-draft-auth-')),restore=activateIsolatedHome(home),original=globalThis.fetch;
 process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:49029';
 const paths:string[]=[];globalThis.fetch=async(input)=>{const pathname=new URL(String(input)).pathname;paths.push(pathname);assert.equal(pathname,'/v1/auth/me');return Response.json({error:'invalid credentials'},{status:401});};
 try{const {POST}=await import('@/app/api/agent-datasets/trace-drafts/route');for(const authorization of [null,'Bearer api_'+'x'.repeat(43)]){const response=await POST(new Request('http://localhost/api/agent-datasets/trace-drafts',{method:'POST',headers:{'content-type':'application/json',...(authorization?{authorization}:{})},body:JSON.stringify({user:'forged',taskId:'private-task'})}));assert.equal(response.status,401);assert.equal(JSON.stringify(await response.json()).includes('private-task'),false);}assert.ok(paths.length>=1);}
 finally{globalThis.fetch=original;const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();restore();}
});
