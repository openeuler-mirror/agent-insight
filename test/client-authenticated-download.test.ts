import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function browser(response:Response,clickError=false) {
  const events:string[]=[];const requests:{url:string;key:string|null}[]=[];
  let downloaded:Blob|undefined;let filename='';const timers:(()=>void)[]=[];
  const apiModule={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module:apiModule,exports:apiModule.exports,Headers,Date,process:{env:{NEXT_PUBLIC_URL_PREFIX:'/insight'}},window:{},localStorage:{getItem:()=> 'current-api-key'},
    fetch:async(url:string,options:RequestInit)=>{requests.push({url,key:new Headers(options.headers).get('x-witty-api-key')});return response;},
  });
  const downloadFile=new URL('../src/lib/client/download.ts',import.meta.url);
  assert.ok(fs.existsSync(downloadFile),'authenticated downloads must use a browser helper');
  const module={exports:{}};
  const anchor={href:'',download:'',click(){events.push('click');filename=this.download;if(clickError)throw Error('click failed');},remove(){events.push('remove');}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(downloadFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module,exports:module.exports,require:(name:string)=>{assert.equal(name,'./api');return apiModule.exports;},
    document:{createElement:(name:string)=>{assert.equal(name,'a');return anchor;},body:{appendChild:()=>events.push('append')}},
    URL:{createObjectURL:(blob:Blob)=>{downloaded=blob;events.push('create');return 'blob:download';},revokeObjectURL:(value:string)=>{assert.equal(value,'blob:download');events.push('revoke');}},
    setTimeout:(callback:()=>void)=>{timers.push(callback);},
  });
  return {download:(module.exports as {downloadApiFile:(url:string,name:string)=>Promise<void>}).downloadApiFile,events,requests,timers,blob:()=>downloaded,filename:()=>filename};
}

test('authenticated Skill download sends the current key and preserves response filename and ZIP bytes',async()=>{
  const bytes=Uint8Array.from([80,75,3,4,0,255,128,10,0]);
  const app=browser(new Response(bytes,{headers:{'content-type':'application/zip','content-disposition':'attachment; filename="checking-v2.zip"'}}));
  await app.download('/api/skills/id/versions/2/download','fallback.zip');
  assert.deepEqual(app.requests,[{url:'/insight/api/skills/id/versions/2/download',key:'current-api-key'}]);
  assert.deepEqual(new Uint8Array(await app.blob()!.arrayBuffer()),bytes);
  assert.equal(app.filename(),'checking-v2.zip');assert.deepEqual(app.events,['create','append','click','remove']);
  assert.equal(app.timers.length,1);app.timers[0]();assert.equal(app.events.at(-1),'revoke');
});

test('download filenames honor UTF-8 disposition and fall back without changing bytes',async()=>{
  for(const [header,name] of [["attachment; filename=ascii.zip; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip",'中文.zip'],['attachment; filename="quoted\\\"name.zip"','quoted"name.zip'],[null,'fallback.zip']] as const) {
    const app=browser(new Response('bytes',{headers:header?{'content-disposition':header}:{}}));
    await app.download('/api/skill-generator/download/thread','fallback.zip');assert.equal(app.filename(),name);assert.equal(await app.blob()!.text(),'bytes');
  }
});

test('non-success responses never download an error body or expose a credential in the URL',async()=>{
  for(const status of [401,403,404,500]) {
    const app=browser(Response.json({error:'private'},{status}));
    await assert.rejects(()=>app.download('/api/skills/id/versions/1/download','fallback.zip'),new RegExp(String(status)));
    assert.deepEqual(app.events,[]);assert.equal(app.requests[0].url.includes('current-api-key'),false);
  }
});

test('a failed download click still removes the anchor and releases the object URL',async()=>{
  const app=browser(new Response('bytes'),true);
  await assert.rejects(()=>app.download('/api/skills/id/versions/1/download','fallback.zip'),/click failed/);
  assert.deepEqual(app.events,['create','append','click','remove']);app.timers[0]();assert.equal(app.events.at(-1),'revoke');
});
