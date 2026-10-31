/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {Worker} from 'node:worker_threads';
import type {ConversationTurn} from '@/lib/evaluation-conversation';
import type {EvaluatorOutput,EvalPoint} from '@/lib/evaluators/eval-output';
import type {ConversationEvidence} from './conversation-evidence';

export const CONVERSATION_RULES_EVALUATOR_ID='preset-conversation-rules';
type Check={turn:number;name:string;verdict:'pass'|'fail'|'unknown';reason:string;blocking:boolean;messageIndex?:number};
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>JSON.stringify(key)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
function partial(want:unknown,got:unknown):boolean {
  if(want&&typeof want==='object'&&!Array.isArray(want))return Boolean(got&&typeof got==='object')&&Object.entries(want).every(([key,v])=>Object.hasOwn(got as object,key)&&partial(v,(got as Record<string,unknown>)[key]));
  return canonical(want)===canonical(got);
}
function regex(pattern:string,text:string):Promise<boolean|null>{
  return new Promise(resolve=>{
    const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');parentPort.postMessage(new RegExp(workerData[0]).test(workerData[1]));",{eval:true,workerData:[pattern,text.slice(0,100000)]});
    const finish=(value:boolean|null)=>{clearTimeout(timer);void worker.terminate();resolve(value);};
    const timer=setTimeout(()=>finish(null),300);
    worker.once('message',value=>finish(Boolean(value)));worker.once('error',()=>finish(null));
  });
}

export async function evaluateConversationRules(turns:ConversationTurn[],evidence:ConversationEvidence[]):Promise<EvaluatorOutput>{
  const checks:Check[]=[];
  for(const [index,turn] of turns.entries()){
    const actual=evidence[index],want=turn.expectation;
    const add=(name:string,value:boolean|null,reason:string)=>checks.push({turn:index+1,name,verdict:value===null?'unknown':value?'pass':'fail',reason,blocking:want.blocking,messageIndex:actual?.messageIndex});
    if(!actual){add('执行证据',null,'未收到该轮的完整输入与回复');continue;}
    if(actual.complete===false){add('执行证据',null,'本轮尚无可确认的最终回复，不能判定规则通过');continue;}
    if(turn.input.replace(/\r\n/g,'\n').trim()!==actual.input.replace(/\r\n/g,'\n').trim()){
      add('轮次关联',null,'该轮实际输入与用例输入不同，不能确认此Trace对应当前Case');continue;
    }
    if(want.contains!==undefined)add('文本包含',actual.output.includes(want.contains),`要求包含：${want.contains}`);
    if(want.pattern)add('正则匹配',await regex(want.pattern,actual.output),'按配置正则检查；超时为未评完整');
    if(want.expectedSkill)add('Skill路由',actual.skills?actual.skills.includes(want.expectedSkill):actual.skill?actual.skill===want.expectedSkill:null,`预期：${want.expectedSkill}；实际：${actual.skills?.join(', ')||actual.skill||'未采集'}`);
    if(want.state)add('业务状态',actual.state?actual.state===want.state:null,`预期：${want.state}；实际：${actual.state||'未采集'}`);
    for(const tool of want.requiredTools){
      const calls=actual.tools?.filter(call=>call.name===tool.name);
      add('必须工具',actual.tools?Boolean(calls?.length):null,tool.name);
      if(tool.arguments)add('工具参数',actual.tools?Boolean(calls?.some(call=>partial(tool.arguments,call.arguments))):null,`${tool.name}：期望参数 ${JSON.stringify(tool.arguments)}`);
    }
    for(const name of want.forbiddenTools)add('禁止工具',actual.tools?!actual.tools.some(call=>call.name===name):null,name);
    if(want.toolOrder.length){let at=-1,ordered=true;for(const name of want.toolOrder){const found=actual.tools?.findIndex((call,i)=>i>at&&call.name===name)??-1;if(found<0){ordered=false;break;}at=found;}add('工具顺序',actual.tools?ordered:null,want.toolOrder.join(' → '));}
    if(want.fields.length){
      let output:unknown;try{output=JSON.parse(actual.output);}catch{add('JSON结构',false,'输出不是有效JSON');}
      if(output!==undefined)for(const field of want.fields){
        let value:unknown=output;for(const key of field.path.split('.'))value=value&&typeof value==='object'&&Object.hasOwn(value,key)?(value as Record<string,unknown>)[key]:undefined;
        const exists=value!==undefined;let valid=!field.required||exists;
        if(exists){
          if(field.type)valid&&=field.type==='array'?Array.isArray(value):field.type==='object'?Boolean(value&&typeof value==='object'&&!Array.isArray(value)):typeof value===field.type;
          if(Object.hasOwn(field,'equals'))valid&&=canonical(value)===canonical(field.equals);
          if(field.min!==undefined)valid&&=typeof value==='number'&&value>=field.min;
          if(field.max!==undefined)valid&&=typeof value==='number'&&value<=field.max;
          if(field.enum)valid&&=field.enum.some(v=>canonical(v)===canonical(value));
        }
        add('字段 '+field.path,valid,'检查必填、类型、范围和取值');
      }
    }
  }
  if(evidence.length>turns.length)checks.push({turn:turns.length,name:'轮次关联',verdict:'unknown',reason:'Trace包含额外用户轮次，无法确认完整Case边界',blocking:true});
  const missing=checks.filter(c=>c.verdict==='unknown').length,failed=checks.filter(c=>c.verdict==='fail').length,passed=checks.filter(c=>c.verdict==='pass').length;
  const points:EvalPoint[]=turns.flatMap((_,index)=>{
    const rows=checks.filter(c=>c.turn===index+1);if(!rows.length)return[];
    const incomplete=rows.some(c=>c.verdict==='unknown');
    const suggestion=rows.some(c=>c.verdict==='fail')?'核对本轮提示、Skill路由与工具参数；结合原Trace确认修改位置。':incomplete?'补充本轮采集证据后重新评测。':'本轮配置规则全部满足。';
    return[{label:`第 ${index+1} 轮业务规则`,...(incomplete?{}:{score:Math.round(100*rows.filter(c=>c.verdict==='pass').length/rows.length)}),evidence:{md:rows.map(c=>`- ${c.name}：${c.verdict==='pass'?'通过':c.verdict==='fail'?'未通过':'未评完整'}；${c.reason}`).join('\n')},suggestion,anchors:evidence[index]?.traceAnchors||[]}];
  });
  return{
    ...(checks.length?{verdict:failed?'fail' as const:missing?'warn' as const:'pass' as const}:{}),
    summary:missing?`未评完整：${missing} 项缺少可确认的证据${failed?`，另有 ${failed} 项未满足`:''}`:checks.length?`${passed}/${checks.length} 项规则满足${checks.some(c=>c.blocking&&c.verdict==='fail')?'，触发业务红线':''}`:'不适用：Case未配置确定性逐轮规则',
    ...(!missing&&checks.length?{score:Math.round(100*passed/checks.length*10)/10}:{}),points,
    evidence:{json:{kind:'conversation-rules',checks,turns:evidence}},
  };
}
