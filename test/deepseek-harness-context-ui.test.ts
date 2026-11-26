import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HarnessContextPanel,HarnessBodyDetails} from '../src/components/observe/HarnessContextPanel';

test('Old Harness traces remain renderable with explicit missing context and no estimated zeros',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries:[{request:{sourceSessionId:'old',eventSequence:1,turn:1,step:1},key:'e:one'}],selectedKey:null,onSelect(){},zh:true}));
 assert.match(html,/没有可用投影/);assert.match(html,/原有 Trace 仍可使用/);assert.match(html,/缺失不代表零/);
});
test('Body disclosures identify categories sources truncation and omitted content',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessBodyDetails,{zh:true,json:JSON.stringify([{itemId:'m1',category:'skill-injection',sourceKind:'tool',sourceCallId:'call1',bodyStatus:'truncated',text:'visible',originalBytes:9000,redactedBytes:9000,storedBytes:8192},{itemId:'m2',category:'user',bodyStatus:'quota-omitted'}])}));
 assert.match(html,/Skill 注入/);assert.match(html,/call1/);assert.match(html,/truncated/);assert.match(html,/quota-omitted/);assert.match(html,/未记录正文/);
});

test('Trace estimates are never relabeled as provider usage in the context table',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries:[{request:{sourceSessionId:'old',eventSequence:1,turn:1,step:1},key:'e:one',usage:{estimated:true,input:999999}}],selectedKey:null,onSelect(){},zh:true}));
 assert.equal(html.includes('999999'),false);
});

test('Unknown context versions and malformed body responses show fallback instead of throwing',()=>{
 const html=renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries:[{request:{sourceSessionId:'old',eventSequence:1,turn:1,step:1,membership:{schemaVersion:99,items:[null]}},key:'e:one'}],selectedKey:null,onSelect(){},zh:true}));
 assert.match(html,/没有可用投影/);
 assert.match(renderToStaticMarkup(React.createElement(HarnessBodyDetails,{json:'{}',zh:true})),/格式不兼容/);
});

test('Dsh-context categories render without captured bodies and retain an explicit source label',()=>{
 const request={sourceSessionId:'s',eventSequence:18,turn:1,step:2,dshContext:{schemaVersion:1,status:'available',source:'dsh-context',version:'0.85.1',sourceSessionId:'s',responseEventSequence:18,turn:1,step:2,approximate:true,total:28,categories:{system:1,tools:2,user:3,inject:4,skill:5,assistant:6,tool:7}}};
 const html=renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries:[{request,key:'r'}],selectedKey:null,onSelect(){},zh:true}));
 assert.match(html,/dsh-context 0.85.1/);assert.match(html,/Skill 注入/);assert.match(html,/近似估算/);assert.doesNotMatch(html,/没有可用投影/);
});

test('Member table counts all categories but pages long lists and keeps missing bytes unknown',()=>{
 const items=Array.from({length:7},(_,index)=>({itemId:`m${index}`,category:index<5?'tool-definition':'user',sourceType:'request-field',bodyStatus:index===0?'truncated':'available',...(index===0?{originalBytes:9000,redactedBytes:8990,storedBytes:8192}:{}),text:'not-expanded'}));
 const html=renderToStaticMarkup(React.createElement(HarnessBodyDetails,{zh:true,json:JSON.stringify(items)}));
 const text=html.replace(/<[^>]*>/g, ""); assert.match(text,/全部 7/);assert.match(text,/工具定义 5/);assert.match(text,/用户消息 2/);
 assert.match(html,/原始 B/);assert.match(html,/脱敏 B/);assert.match(html,/存储 B/);assert.match(html,/9,000/);assert.match(html,/8,192/);assert.match(html,/—/);
 assert.match(html,/m4/);assert.equal(html.includes('m5'),false);assert.equal(html.includes('not-expanded'),false);
 assert.match(html,/展开成员面板/);assert.match(html,/字节不是 Token/);
});

test('Member search combines category with case insensitive ID source and Chinese labels',async()=>{
 const {filterHarnessBodyMembers}=await import('../src/components/observe/HarnessContextPanel');
 const items=[{itemId:'tool:bash',category:'tool-definition',sourceType:'request-field'},{itemId:'m1',category:'user',sourceKind:'compact-checkpoint'},{itemId:'m2',category:'skill-injection',sourceCallId:'CALL-123'}];
 assert.deepEqual(filterHarnessBodyMembers(items,'all',' BASH ').map(x=>x.index),[0]);
 assert.deepEqual(filterHarnessBodyMembers(items,'user','compact-checkpoint').map(x=>x.index),[1]);
 assert.deepEqual(filterHarnessBodyMembers(items,'all','用户消息').map(x=>x.index),[1]);
 assert.deepEqual(filterHarnessBodyMembers(items,'all','call-123').map(x=>x.index),[2]);
 assert.deepEqual(filterHarnessBodyMembers(items,'tool-definition','compact-checkpoint'),[]);
 assert.deepEqual(filterHarnessBodyMembers(items,'all','unmatched'),[]);
});


// Native event ordering and session boundaries determine the visible timeline.
test('Context event timeline isolates sources deduplicates and anchors the earliest later request',async()=>{
 const {collectHarnessContextEvents,harnessEventFamily}=await import('../src/components/observe/HarnessRequestInspector');
 const prune={sourceSessionId:'s',eventSequence:20,eventType:'compaction/prune',body:{shadowedSeqs:[10]}};
 const model={sourceSessionId:'s',eventSequence:30,eventType:'model/selection',body:{model:'other'}};
 const entries:any=[{key:'later',request:{sourceSessionId:'s',eventSequence:50,contextEvents:[model,prune]}},{key:'earlier',request:{sourceSessionId:'s',eventSequence:25,contextEvents:[prune,{...prune,eventSequence:99},{...prune,eventSequence:-1},{...prune,sourceSessionId:'other'}]}},{key:'foreign',request:{sourceSessionId:'other',eventSequence:25,contextEvents:[prune]}}];
 const rows=collectHarnessContextEvents(entries,'s');
 assert.deepEqual(rows.map(r=>[r.event.eventSequence,r.target.key]),[[20,'earlier'],[30,'later']]);
 assert.equal(harnessEventFamily('compaction/prune'),'prune');assert.equal(harnessEventFamily('compaction/summary'),'compaction');assert.equal(harnessEventFamily('model/selection'),'model');
 assert.deepEqual(collectHarnessContextEvents(entries,'missing'),[]);
});

test('Context workspace entry stays visible without expanding legacy request references',async()=>{
 const {HarnessRequestInspector}=await import('../src/components/observe/HarnessRequestInspector');
 const html=renderToStaticMarkup(React.createElement(HarnessRequestInspector,{entries:[{key:'s1',request:{sourceSessionId:'s',eventSequence:161,turn:6,step:1}}],selectedKey:'s1',onSelect(){},zh:true}));
 assert.match(html,/请求成员与正文/);assert.match(html,/相邻请求对比/);assert.match(html,/上下文事件定位/);assert.match(html,/无需展开右侧请求标识/);
 assert.equal(renderToStaticMarkup(React.createElement(HarnessRequestInspector,{entries:[],selectedKey:null,onSelect(){},zh:true})), '');
});


test('Request windows default to ten and reveal distant selections without changing manual width',async()=>{
 const {clampRequestWindow,revealRequestWindow,shiftRequestWindow}=await import('../src/components/observe/harness-request-window');
 assert.deepEqual(clampRequestWindow(120),{startIndex:0,endIndex:9});
 assert.deepEqual(clampRequestWindow(6),{startIndex:0,endIndex:5});
 assert.deepEqual(clampRequestWindow(0),{startIndex:0,endIndex:-1});
 assert.deepEqual(revealRequestWindow(120,119),{startIndex:110,endIndex:119});
 assert.deepEqual(revealRequestWindow(120,60),{startIndex:55,endIndex:64});
 const manual={startIndex:20,endIndex:29};
 assert.deepEqual(revealRequestWindow(120,25,manual),manual);
 assert.deepEqual(revealRequestWindow(120,95,manual),{startIndex:90,endIndex:99});
 assert.deepEqual(shiftRequestWindow(120,{startIndex:95,endIndex:114},1),{startIndex:100,endIndex:119});
 assert.deepEqual(shiftRequestWindow(120,{startIndex:5,endIndex:24},-1),{startIndex:0,endIndex:19});
 assert.deepEqual(clampRequestWindow(10,manual),{startIndex:0,endIndex:9});
 assert.deepEqual(revealRequestWindow(120,-1,manual),manual);
});

test('Long context sessions render ten local requests and initially reveal the selected source and call',()=>{
 const make=(source:string,count:number)=>Array.from({length:count},(_,index)=>({key:source+':'+index,request:{sourceSessionId:source,eventSequence:10+index*3,turn:1,step:index+1}}));
 const entries=[...make('a',120),...make('b',30)];
 const render=(selectedKey:string|null)=>renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries,selectedKey,onSelect(){},zh:true}));
 const first=render(null);
 assert.match(first,/第 1–10 \/ 120 次请求/);
 assert.equal((first.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr/g)??[]).length,10);
 assert.match(first,/>#37<\/button>/);assert.doesNotMatch(first,/>#40<\/button>/);
 assert.doesNotMatch(first,/全量请求概览与范围选择/);
 assert.match(first,/<details class="mt-2 text-xs"><summary/);
 const tail=render('a:119');assert.match(tail,/第 111–120 \/ 120 次请求/);assert.match(tail,/>#367<\/button>/);
 const other=render('b:29');assert.match(other,/第 21–30 \/ 30 次请求/);assert.doesNotMatch(other,/>#367<\/button>/);
 const twenty=renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries:make('s',20),selectedKey:null,onSelect(){},zh:true}));
 assert.match(twenty,/第 1–10 \/ 20 次请求/);assert.match(twenty,/后 10 次/);
 const short=renderToStaticMarkup(React.createElement(HarnessContextPanel,{entries:make('s',6),selectedKey:null,onSelect(){},zh:true}));
 assert.match(short,/第 1–6 \/ 6 次请求/);assert.doesNotMatch(short,/全量请求概览与范围选择/);
});
