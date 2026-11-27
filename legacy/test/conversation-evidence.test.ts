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

test('复用跨平台Skill入口及参数名，成功/失败/未知状态与轮次隔离',()=>{
 for(const [name,key] of [['load_skill','skill_name'],['skill_view','skill'],['skill_tool','skillName'],['skill.loan','unused']]){
  const args=key==='unused'?{}:{[key]:'loan'};
  const turns=replayConversation([{role:'user',content:'q'},{role:'assistant',tool_calls:[{id:'load',function:{name,arguments:args}}]},{role:'tool',tool_call_id:'load',content:'loaded'},{role:'assistant',content:'done',tool_calls:[]},{role:'user',content:'next'},{role:'assistant',content:'done',tool_calls:[]}]);
  assert.deepEqual(turns[0].loadedSkills,['loan']);assert.equal(turns[0].skillsComplete,true);
  assert.deepEqual(turns[1].loadedSkills,[]);assert.equal(turns[1].skillsComplete,true);
 }
 const state=(state:string)=>replayConversation([{role:'user',content:'q'},{role:'assistant',tool_calls:[{function:{name:'skill',arguments:{name:'loan'}},state}]},{role:'assistant',content:'done',tool_calls:[]}])[0];
 assert.deepEqual(state('error').loadedSkills,[]);assert.equal(state('error').skillsComplete,true);
 assert.equal(state('running').skillsComplete,false);
 const metadata=replayConversation([{role:'user',content:'q'},{role:'assistant',content:'done',metadata:{evaluation:{skill:'loan'}},tool_calls:[]}])[0];
 assert.deepEqual(metadata.loadedSkills,[]);
});

test('Skill关联返回的显式失败优先于completed，不把MCP错误当成功加载',()=>{
 for(const [state,result] of [['completed',{is_error:true,content:'failed'}],['completed',{content:JSON.stringify({isError:true,content:[]})}],[undefined,{isError:true,content:'failed'}]] as const){
  const [turn]=replayConversation([{role:'user',content:'q'},{role:'assistant',tool_calls:[{id:'load',function:{name:'load_skill',arguments:{name:'loan'}},...(state?{state}:{})}]},{role:'tool',tool_call_id:'load',...result},{role:'assistant',content:'done',tool_calls:[]}]);
  assert.deepEqual(turn.loadedSkills,[]);assert.equal(turn.skillsComplete,true);
 }
});


test('内嵌MCP失败结果不算成功加载，旧Skill证据保持原口径',()=>{
 const [turn]=replayConversation([{role:'user',content:'q'},{role:'assistant',tool_calls:[{id:'load',function:{name:'skill',arguments:{name:'loan'}},state:'completed',output:JSON.stringify({isError:true,content:[]})}]},{role:'assistant',content:'done',tool_calls:[]}]);
 assert.deepEqual(turn.loadedSkills,[]);assert.equal(turn.skillsComplete,true);
 assert.deepEqual(turn.skills,['loan']);
});
