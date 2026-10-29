import assert from 'node:assert/strict';
import test from 'node:test';
import { replayConversation } from '@/lib/engine/experiment/conversation-evidence';

test('逐轮回放按调用ID关联工具返回，并保留消息定位',()=>{
 const turns=replayConversation([
  {role:'user',content:'第一问'},
  {role:'assistant',content:'',tool_calls:[{id:'call-1',function:{name:'lookup',arguments:'{"id":7}'}}]},
  {role:'tool',tool_call_id:'call-1',content:'{"value":42}'},
  {role:'assistant',content:'答一'},
  {role:'user',content:'第二问'},
  {role:'assistant',content:'答二',tool_calls:[]},
 ]);
 assert.equal(turns.length,2);assert.equal(turns[0].output,'答一');assert.equal(turns[0].messageIndex,0);
 assert.deepEqual(turns[0].tools,[{name:'lookup',arguments:{id:7},result:{value:42}}]);
 assert.deepEqual(turns[1].tools,[]);
});

test('未采集工具证据不同于确认无工具，无回复不能伪装完整轮次',()=>{
 const turns=replayConversation([{role:'user',content:'q'},{role:'assistant',content:'answer'},{role:'user',content:'unfinished'}]);
 assert.equal(turns.length,2);assert.equal(turns[0].tools,undefined);assert.equal(turns[1].complete,false);
 const broken=replayConversation([{role:'user',content:'q'},{role:'assistant',content:'answer',tool_calls:[{id:'x',function:{name:'pay',arguments:'invalid'}}]}]);
 assert.equal(broken[0].tools,undefined);
});

test('原生parts提供完整空工具证据，成功Skill调用与内嵌工具返回保留',()=>{
 const rows=replayConversation([{role:'user',content:'load'},{role:'assistant',content:'ready',parts:[{type:'text',text:'ready'}],tool_calls:[{id:'c1',function:{name:'skill',arguments:'{"name":"loan"}'},state:'completed',output:'loaded'}]},{role:'user',content:'continue'},{role:'assistant',content:'done',parts:[{type:'text',text:'done'}]}]);
 assert.deepEqual(rows[0].skills,['loan']);assert.equal(rows[0].tools?.[0].result,'loaded');
 assert.deepEqual(rows[1].tools,[]);
});
