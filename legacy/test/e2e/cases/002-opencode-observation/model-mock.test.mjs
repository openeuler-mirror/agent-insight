import test from 'node:test';
import assert from 'node:assert/strict';
import { mockReply,startModelMock } from './model-mock.mjs';

const expected={file:'/tmp/e2e/messages',firstLine:'Jun 14 fixture event',lineCount:2000};
test('model fixture requests a real readonly tool and requires its output before answering',()=>{
 const input={messages:[{role:'user',content:'请检查 /tmp/e2e/messages'}],tools:[{function:{name:'shell',parameters:{properties:{command:{type:'string'}}}}}]};
 const call=mockReply(input,expected);assert.equal(call.tool_calls[0].function.name,'shell');
 assert.match(JSON.parse(call.tool_calls[0].function.arguments).command,/awk/);
 const answer=mockReply({...input,messages:[...input.messages,{role:'tool',content:'2000\nJun 14 fixture event'}]},expected);
 assert.match(answer.content,/2000/);assert.match(answer.content,/Jun 14 fixture event/);
 assert.throws(()=>mockReply({...input,messages:[...input.messages,{role:'tool',content:'failed'}]},expected),/actual tool/);
});
test('unexpected paths or tools fail closed instead of fabricating success',()=>{
 assert.throws(()=>mockReply({messages:[{role:'user',content:'read /etc/passwd'}],tools:[{function:{name:'shell'}}]},expected),/fixture/);
 assert.throws(()=>mockReply({messages:[{role:'user',content:expected.file}],tools:[{function:{name:'write'}}]},expected),/readonly/);
});
test('streaming fixture sends progressive chunks and accepts cancellation',async()=>{
 const mock=await startModelMock({}, {reply:()=>({role:'assistant',content:'abcdef'}),streamPlan:()=>({chunkChars:2,delayMs:2})});
 try{const r=await fetch(mock.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'mock',stream:true,messages:[]})});const text=await r.text();assert.match(text,/"content":"ab"/);assert.match(text,/"content":"cd"/);assert.match(text,/"content":"ef"/);assert.match(text,/\[DONE\]/);}finally{await mock.close();}
});
