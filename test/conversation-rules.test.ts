/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeConversationTurns} from '@/lib/evaluation-conversation';
import {evaluateConversationRules} from '@/lib/engine/experiment/conversation-rules';
test('逐轮路由、审批红线、工具参数按对应轮评分',async()=>{
 const turns=normalizeConversationTurns({input:'',turns:[{input:'申请',expectation:{expectedSkill:'loan',requiredTools:[{name:'review',arguments:{approved:false}}],forbiddenTools:['pay'],contains:'人工'}}]});
 const result=await evaluateConversationRules(turns,[{input:'申请',output:'已转人工',messageIndex:0,skill:'loan',tools:[{name:'review',arguments:{approved:true}}]}]);
 assert.equal(result.verdict,'fail');assert.equal(result.points?.length,1);assert.equal(result.score,80);
 assert.match(JSON.stringify(result.evidence),/工具参数/);
});
test('缺证据不计零分，已确认空工具列表才能判断未调用',async()=>{
 const turns=normalizeConversationTurns({input:'q',turns:[{input:'q',expectation:{requiredTools:[{name:'lookup'}]}}]});
 const missing=await evaluateConversationRules(turns,[{input:'q',output:'x',messageIndex:0}]);assert.equal(missing.score,undefined);assert.equal(missing.verdict,'warn');
 const empty=await evaluateConversationRules(turns,[{input:'q',output:'x',messageIndex:0,tools:[]}]);assert.equal(empty.score,0);assert.equal(empty.verdict,'fail');
 const noRound=await evaluateConversationRules(turns,[]);assert.equal(noRound.score,undefined);
});
test('输出字段约束和顺序明确检查；错误关联的轮次不伪装通过',async()=>{
 const turns=normalizeConversationTurns({input:'q',turns:[{input:'q',expectation:{fields:[{path:'amount',type:'number',min:10,max:20}],toolOrder:['check','review']}}]});
 const evidence={input:'q',output:'{"amount":15}',messageIndex:0,tools:[{name:'check',arguments:{}},{name:'review',arguments:{}}]};
 assert.equal((await evaluateConversationRules(turns,[evidence])).score,100);
 assert.equal((await evaluateConversationRules(turns,[{...evidence,input:'another task'}])).score,undefined);
});

test('没有最终回复或存在额外未回复用户轮次时不能判通过',async()=>{
 const {replayConversation}=await import('@/lib/engine/experiment/conversation-evidence');
 const turns=normalizeConversationTurns({input:'q',turns:[{input:'q',expectation:{contains:'answer'}}]});
 const extra=await evaluateConversationRules(turns,replayConversation([{role:'user',content:'q'},{role:'assistant',content:'answer'},{role:'user',content:'unfinished'}]));
 assert.equal(extra.score,undefined);assert.notEqual(extra.verdict,'pass');
 const toolOnly=normalizeConversationTurns({input:'q',turns:[{input:'q',expectation:{requiredTools:[{name:'lookup'}]}}]});
 const partial=await evaluateConversationRules(toolOnly,replayConversation([{role:'user',content:'q'},{role:'assistant',content:'',tool_calls:[{id:'one',function:{name:'lookup',arguments:'{}'}}]}]));
 assert.equal(partial.score,undefined);assert.notEqual(partial.verdict,'pass');
});
