import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import * as runtime from './runtime.mjs';

async function server(t,handle){
 const value=http.createServer(handle);await new Promise(resolve=>value.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{value.closeAllConnections();value.close(resolve);}));
 return `http://127.0.0.1:${value.address().port}`;
}
test('a closed session-status GET is retried once and records no query or credentials',async t=>{
 assert.equal(typeof runtime.fetchStatusResponse,'function');
 let calls=0;const events=[];const base=await server(t,(req,res)=>{if(++calls===1){req.socket.destroy();return;}res.setHeader('content-type','application/json');res.end('{"status":"running"}');});
 const response=await runtime.fetchStatusResponse(base+'/api/skill-workbench/sessions/session-id?private=do-not-log',{headers:{'x-witty-api-key':'credential-do-not-log'}},{onTransportFailure:e=>events.push(e)});
 assert.equal(calls,2);assert.deepEqual(await response.json(),{status:'running'});assert.equal(events.length,1);assert.equal(events[0].retrying,true);assert.equal(events[0].code,'UND_ERR_SOCKET');assert.ok(!JSON.stringify(events).includes('do-not-log'));
});
test('a persistent closed status connection fails after two attempts',async t=>{
 assert.equal(typeof runtime.fetchStatusResponse,'function');let calls=0;const base=await server(t,(req)=>{calls++;req.socket.destroy();});
 await assert.rejects(runtime.fetchStatusResponse(base+'/api/skill-workbench/sessions/session-id'),/UND_ERR_SOCKET/);assert.equal(calls,2);
});
test('HTTP 500 remains a failure response without transport retry',async t=>{
 assert.equal(typeof runtime.fetchStatusResponse,'function');let calls=0;const base=await server(t,(req,res)=>{calls++;res.writeHead(500);res.end('{}');});
 const response=await runtime.fetchStatusResponse(base+'/api/skill-workbench/sessions/session-id');assert.equal(response.status,500);assert.equal(calls,1);
});
test('writes and other GET routes are not replayed after a closed connection',async t=>{
 assert.equal(typeof runtime.fetchStatusResponse,'function');let calls=0;const base=await server(t,(req)=>{calls++;req.socket.destroy();});
 await assert.rejects(runtime.fetchStatusResponse(base+'/api/skill-workbench/sessions/session-id',{method:'POST',body:'{}'}),/UND_ERR_SOCKET/);
 await assert.rejects(runtime.fetchStatusResponse(base+'/api/experiments/experiment-id'),/UND_ERR_SOCKET/);assert.equal(calls,2);
});
test('explicit timeout or cancellation is not replayed',async t=>{
 let calls=0;const events=[];const controller=new AbortController();
 const base=await server(t,()=>{calls++;setTimeout(()=>controller.abort(),10);});
 await assert.rejects(runtime.fetchStatusResponse(base+'/api/skill-workbench/sessions/session-id',{signal:controller.signal},{onTransportFailure:e=>events.push(e)}));
 assert.equal(calls,1);assert.equal(events.length,1);assert.equal(events[0].retrying,false);
});
