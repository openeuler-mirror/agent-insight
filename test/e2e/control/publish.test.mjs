import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AtomGit } from './atomgit.mjs';
import { publishResult } from './publish.mjs';

const job={caseIds:['001','002','003','004','005'],repository:'gyctl/agent-insight',pr:1,id:'f'.repeat(32),headSha:'a'.repeat(40),baseSha:'b'.repeat(40)};
const report={selected:job.caseIds,runId:'local-test',mode:'mock',testedSha:'c'.repeat(40),status:'BLOCKED',productionBuild:{status:'FAIL',reason:'fixture compiler error',durationMs:1200},npmTest:{status:'NOT_RUN'},scenarios:Array.from({length:5},(_,i)=>({id:String(i+1).padStart(3,'0'),title:'case',status:'BLOCKED',reason:'not executed'}))};
test('real HTTP API client publishes exact-SHA report once and refuses stale PR',async t=>{
 let current=job.headSha;const comments=[];const token='local-api-fixture';
 const server=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+token);let body='';for await(const part of req)body+=part;
  res.setHeader('content-type','application/json');
  if(req.url.endsWith('/pulls/1'))res.end(JSON.stringify({state:'open',head:{sha:current},base:{sha:job.baseSha}}));
  else if(req.method==='POST'){const comment={id:1,...JSON.parse(body)};comments.push(comment);res.end(JSON.stringify(comment));}
  else if(req.url.includes('/comments/1'))res.end(JSON.stringify(comments[0]));
  else res.end(JSON.stringify(comments));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const api=new AtomGit({token,baseUrl:'http://127.0.0.1:'+server.address().port,localTest:true});
 assert.equal((await publishResult(api,job,report)).status,'PUBLISHED');assert.equal(comments.length,1);
 assert.ok(comments[0].body.includes('BLOCKED')||comments[0].body.includes('阻塞'));
 assert.ok(comments[0].body.includes(job.headSha));assert.ok(comments[0].body.includes('生产编译：失败'));assert.ok(comments[0].body.includes('fixture compiler error'));
 assert.equal((await publishResult(api,job,report)).status,'ALREADY_PUBLISHED');assert.equal(comments.length,1);
 current='d'.repeat(40);assert.equal((await publishResult(api,job,report)).status,'STALE');assert.equal(comments.length,1);
});
test('publisher rejects missing cases and dirty local results before any network mutation',async()=>{
 const api={readPull:()=>{throw Error('no network');}};
 await assert.rejects(()=>publishResult(api,job,{...report,dirtyWorkingTree:true}),/dirty/);
 await assert.rejects(()=>publishResult(api,job,{...report,scenarios:[]}),/five/);
});
test('API waits for a slow successful write so callers can verify it without a duplicate mutation',{timeout:10000},async t=>{
 const server=http.createServer((req,res)=>setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:23}));},5200));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const api=new AtomGit({token:'slow-local-fixture',baseUrl:'http://127.0.0.1:'+server.address().port,localTest:true});
 assert.equal((await api.request('POST','/repos/example/probe/pulls',{title:'local fixture'})).id,23);
});
test('publication verifies exact content through the PR comment list when individual comment reads are unavailable',async()=>{
 const comments=[];
 const api={repoPath:()=>'/repos/'+job.repository,readPull:async()=>({state:'open',head:{sha:job.headSha},base:{sha:job.baseSha}}),request:async(method,route)=>{if(route.includes('/pulls/comments/'))throw Error('Individual comment endpoint returns HTTP 400');return comments;},createComment:async(repo,n,body)=>{const c={id:24,body};comments.push(c);return c;}};
 assert.equal((await publishResult(api,job,report)).status,'PUBLISHED');
 comments[0].body+=' changed';await assert.rejects(()=>publishResult(api,job,report),/mismatch/);
});
test('AtomGit discussion creation IDs are distinguished from canonical comment note IDs',async()=>{
 const comments=[];
 const api={repoPath:()=>'/repos/'+job.repository,readPull:async()=>({state:'open',head:{sha:job.headSha},base:{sha:job.baseSha}}),request:async()=>comments,createComment:async(repo,n,body)=>{comments.push({id:25,discussion_id:'discussion-key',body});return {id:'discussion-key',note_id:25,body};}};
 assert.deepEqual(await publishResult(api,job,report),{status:'PUBLISHED',commentId:25});
});
