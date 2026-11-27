/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {attachConversationAnchors} from './conversation-anchors';
import {toRawTraceInteractions} from '@/lib/engine/observability/fault-path';
import {isSkillLoaderToolName} from '@/lib/evaluators/evaluator-case-context';

export interface ConversationEvidence {
  input: string;
  output: string;
  messageIndex: number;
  assistantMessageIndex?: number;
  complete?: boolean;
  traceAnchors?: string[];
  tools?: Array<{name:string;arguments:Record<string,unknown>;result?:unknown;status?:string}>;
  skill?: string;
  skills?: string[];
  loadedSkills?: string[];
  skillsComplete?: boolean;
  state?: string;
}

function record(value:unknown):Record<string,unknown> {
  return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function text(value:unknown):string {
  if (typeof value==='string') return value;
  if (Array.isArray(value)) return value.map(part=>typeof record(part).text==='string' ? record(part).text : '').join('\n');
  return '';
}
function json(value:unknown):unknown {
  if(typeof value!=='string')return value;
  try{return JSON.parse(value);}catch{return value;}
}

export function replayConversation(messages:unknown[]):ConversationEvidence[] {
  const turns:ConversationEvidence[]=[];
  let current:ConversationEvidence|undefined, invalidTools=false;
  let calls=new Map<string,NonNullable<ConversationEvidence['tools']>[number]>();
  let skillCalls:Array<{name?:string;resultStatus?:string;tool:NonNullable<ConversationEvidence['tools']>[number]}>=[];
  const finish=()=>{if(current){
    if(invalidTools)delete current.tools;
    if(current.tools){
      current.loadedSkills=[];current.skillsComplete=true;
      for(const {name,tool,resultStatus} of skillCalls){
        const status=record(tool.result).isError===true?'error':(resultStatus||tool.status)?.toLowerCase();
        if(!name || !status || !['completed','success','succeeded','done','error','failed','cancelled','canceled'].includes(status))current.skillsComplete=false;
        else if(['completed','success','succeeded','done'].includes(status)&&!current.loadedSkills.includes(name))current.loadedSkills.push(name);
      }
    }
    turns.push(current);
  }};
  for(const [index,raw] of toRawTraceInteractions(messages).entries()){
    const message=record(raw), role=message.role || message.type;
    if(role==='user'){
      finish();invalidTools=false;calls=new Map();skillCalls=[];
      current={input:text(message.content),output:'',messageIndex:index,complete:false};
      continue;
    }
    if(!current)continue;
    if(role==='assistant'){
      const output=text(message.content);
      if(output){current.output=output;current.assistantMessageIndex=index;}
      const facts=record(record(message.metadata).evaluation);
      if(typeof facts.skill==='string')current.skill=facts.skill;
      if(typeof facts.state==='string')current.state=facts.state;
      if(Array.isArray(message.parts))current.tools??=[];
      const nativeParts=Array.isArray(message.parts)?message.parts.filter(p=>record(p).type==='tool').map(raw=>{const part=record(raw),state=record(part.state);return {id:part.callID||part.id,function:{name:part.tool,arguments:state.input},state:state.status,output:state.output};}):undefined;
      const toolCalls=Array.isArray(message.tool_calls)?message.tool_calls:nativeParts;
      current.complete=Boolean(output.trim())&&(!toolCalls||toolCalls.length===0);
      if(toolCalls){
        current.tools??=[];
        for(const rawCall of toolCalls){
          const call=record(rawCall), fn=record(call.function || call), argumentsValue=json(fn.arguments);
          if(typeof fn.name!=='string' || !argumentsValue || typeof argumentsValue!=='object' || Array.isArray(argumentsValue)){invalidTools=true;continue;}
          const tool:NonNullable<ConversationEvidence['tools']>[number]={name:fn.name,arguments:argumentsValue as Record<string,unknown>,...(Object.hasOwn(call,'output')?{result:json(call.output)}:{}),...(typeof call.state==='string'?{status:call.state}:{})};
          if(fn.name==='skill'&&typeof tool.arguments.name==='string'&&tool.status==='completed'){current.skills??=[];if(!current.skills.includes(tool.arguments.name))current.skills.push(tool.arguments.name);}
          const meta=record(call.skill), prefixed=fn.name.toLowerCase().startsWith('skill.')?fn.name.slice(6):undefined;
          if(isSkillLoaderToolName(fn.name)||prefixed||typeof meta.name==='string'){
            const name=[meta.name,tool.arguments.skill,tool.arguments.name,tool.arguments.skill_name,tool.arguments.skillName,...(['skill','load_skill'].includes(fn.name.toLowerCase())?[tool.arguments.id]:[]),prefixed].find(value=>typeof value==='string'&&value.trim());
            skillCalls.push({name:typeof name==='string'?name.trim():undefined,tool});
          }
          current.tools.push(tool);
          if(typeof call.id==='string')calls.set(call.id,tool);
        }
      }
    } else if(role==='tool' && typeof message.tool_call_id==='string'){
      const call=calls.get(message.tool_call_id);
      if(call){
        call.result=json(message.content);
        const skill=skillCalls.find(fact=>fact.tool===call);
        if(skill){
          const result=record(call.result);
          if(message.is_error===true||message.isError===true||message.error||result.isError===true)skill.resultStatus='error';
          else if(!call.status||['running','pending'].includes(call.status))skill.resultStatus='completed';
        }
      }
    }
  }
  finish();
  return attachConversationAnchors(messages,turns);
}
