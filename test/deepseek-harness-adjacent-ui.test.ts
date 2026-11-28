
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HarnessAdjacentDiff} from '../src/components/observe/HarnessAdjacentDiff';
import {HarnessContextTabs} from '../src/components/observe/HarnessContextTabs';
import {HarnessContextPanel} from '../src/components/observe/HarnessContextPanel';
import type {ContextEntry} from '../src/lib/ingest/deepseek-harness-otel/context-view';
const entries:ContextEntry[]=[1,2].map(seq=>({key:'r'+seq,request:{sourceSessionId:'s',eventSequence:seq,turn:seq,step:1,membership:{schemaVersion:1,bindingStatus:'bound',items:[{itemId:'ENHANCED_ONLY',category:'secret-category',originalBytes:999999,contentFingerprint:'PRIVATE'}],tokenEstimate:{approximate:true,categories:{'secret-category':999999}}}}}));
test('v1 removes member fallback and private identities despite populated history',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessAdjacentDiff,{entries,current:entries[1].request,zh:true}));
 assert.match(html,/暂时无法比较这两次请求/);assert.match(html,/不代表请求失败/);
 assert.doesNotMatch(html,/ENHANCED_ONLY|PRIVATE|新增成员清单|变化成员/);
});
test('v1 trends do not use member counts bytes or token estimates',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries,selectedKey:'r2',onSelect(){},zh:true}));
 assert.match(html,/没有可用投影/);assert.doesNotMatch(html,/secret-category|999999|原始字段字节/);
});
test('first captured request keeps explicit missing reason instead of zero',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessAdjacentDiff,{entries,current:entries[0].request,zh:true}));
 assert.match(html,/不代表真实会话的首请求/);assert.doesNotMatch(html,/新增成员/);
});
test('original detail and independent right scrolling survive missing projection',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessContextTabs,{entries,selectedKey:'r2',onSelect(){},zh:true,}, React.createElement('p',null,'Existing detail')));
 assert.doesNotMatch(html,/模型请求 #2 · 2\/1/);assert.match(html,/Existing detail/);assert.match(html,/min-h-0 flex-1 flex-col overflow-hidden/);assert.doesNotMatch(html,/harness-tab-events/);assert.equal((html.match(/role="tab"/g)??[]).length,3);
 assert.doesNotMatch(html,/上下文变化|查看事件详情|未采集到相关事件|不代表会话总次数/);
});


test('Unavailable adjacent comparisons explain a missing plugin baseline in both languages without raw codes',()=>{
 const requests=[10,11].map(seq=>({key:'r'+seq,request:{sourceSessionId:'s',eventSequence:seq,turn:seq,step:1,dshContext:{schemaVersion:1,status:'available',source:'dsh-context',version:'0.85.1',sourceSessionId:'s',responseEventSequence:seq,turn:seq,step:1,approximate:true,total:7,categories:{system:1,tools:1,user:1,inject:1,skill:1,assistant:1,tool:1},delta:{status:'no-previous-request'}}}}));
 for(const zh of [true,false]){
  const html=renderToStaticMarkup(React.createElement(HarnessAdjacentDiff,{entries:requests,current:requests[1].request,zh}));
  assert.match(html,/#10 → #11/);assert.match(html,/role="status"/);
  assert.match(html,zh?/比较基准/:/previous context baseline/);
  assert.doesNotMatch(html,/projection-no-previous-request|existing-source-diff-unavailable|Source: Unavailable/);
 }
});
