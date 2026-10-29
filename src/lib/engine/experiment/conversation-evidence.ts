/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export interface ConversationEvidence {
  input: string;
  output: string;
  messageIndex: number;
  assistantMessageIndex?: number;
  tools?: Array<{name:string;arguments:Record<string,unknown>;result?:unknown}>;
  skill?: string;
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
  let current:ConversationEvidence|undefined, responded=false, invalidTools=false;
  let calls=new Map<string,NonNullable<ConversationEvidence['tools']>[number]>();
  const finish=()=>{if(current&&responded){if(invalidTools)delete current.tools;turns.push(current);}};
  for(const [index,raw] of messages.entries()){
    const message=record(raw), role=message.role || message.type;
    if(role==='user'){
      finish();responded=false;invalidTools=false;calls=new Map();
      current={input:text(message.content),output:'',messageIndex:index};
      continue;
    }
    if(!current)continue;
    if(role==='assistant'){
      responded=true;
      const output=text(message.content);
      if(output){current.output=output;current.assistantMessageIndex=index;}
      const facts=record(record(message.metadata).evaluation);
      if(typeof facts.skill==='string')current.skill=facts.skill;
      if(typeof facts.state==='string')current.state=facts.state;
      if(Array.isArray(message.tool_calls)){
        current.tools??=[];
        for(const rawCall of message.tool_calls){
          const call=record(rawCall), fn=record(call.function || call), argumentsValue=json(fn.arguments);
          if(typeof fn.name!=='string' || !argumentsValue || typeof argumentsValue!=='object' || Array.isArray(argumentsValue)){invalidTools=true;continue;}
          const tool={name:fn.name,arguments:argumentsValue as Record<string,unknown>};
          current.tools.push(tool);
          if(typeof call.id==='string')calls.set(call.id,tool);
        }
      }
    } else if(role==='tool' && typeof message.tool_call_id==='string'){
      const call=calls.get(message.tool_call_id);
      if(call)call.result=json(message.content);
    }
  }
  finish();
  return turns;
}
