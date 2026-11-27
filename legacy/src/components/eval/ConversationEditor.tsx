/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

'use client';

import {useEffect,useRef,useState} from 'react';
import {Plus} from 'lucide-react';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Select} from '@/components/ui/select';
import {hasLegacyTurnRules,simplifyConversationTurn,type ConversationTurn,type TurnExpectation} from '@/lib/evaluation-conversation';
import {safeUUID} from '@/lib/safe-uuid';

const emptyRules:TurnExpectation={requiredTools:[],forbiddenTools:[],toolOrder:[],fields:[],blocking:true};
export function newConversationTurn(input='',expectedOutput=''):ConversationTurn{return{id:safeUUID(),input,expectedOutput,expectation:{...emptyRules,outputMatch:'contains'}};}

function NameList({value,onChange}:{value:string[];onChange:(value:string[])=>void}){
  const [text,setText]=useState(value.join(', '));
  return <Input value={text} onChange={e=>setText(e.target.value)} onBlur={()=>onChange(text.split(/[,，]/).map(v=>v.trim()).filter(Boolean))}/>;
}

function TypedValue({value,onChange,onValid}:{value:unknown;onChange:(value:unknown)=>void;onValid:(valid:boolean)=>void}){
  const kind=typeof value==='number'?'number':typeof value==='boolean'?'boolean':value!==null&&typeof value==='object'?'json':'string';
  const display=kind==='json'?JSON.stringify(value):String(value??'');
  const [text,setText]=useState(display),[error,setError]=useState('');
  const validCallback=useRef(onValid);validCallback.current=onValid;
  useEffect(()=>{setText(display);setError('');validCallback.current(true);},[display]);
  useEffect(()=>()=>validCallback.current(true),[]);
  return <div className="grid gap-2"><div className="flex items-center gap-2"><Select modal={false} contentClassName="z-[1200]" value={kind} aria-label="期望值类型" options={[{value:'string',label:'文本'},{value:'number',label:'数值'},{value:'boolean',label:'布尔'},{value:'json',label:'对象/数组'}]} onChange={type=>onChange(type==='number'?0:type==='boolean'?false:type==='json'?{}:'')}/>
    {kind==='boolean'?<Select modal={false} contentClassName="z-[1200]" value={String(value)} aria-label="期望布尔值" options={[{value:'true',label:'是'},{value:'false',label:'否'}]} onChange={v=>onChange(v==='true')}/>:<Input aria-label="期望值" value={text} onChange={e=>{setText(e.target.value);try{
      let next:unknown=e.target.value;
      if(kind==='number'){next=Number(e.target.value);if(!e.target.value.trim()||!Number.isFinite(next))throw Error();}
      if(kind==='json')next=JSON.parse(e.target.value);
      onChange(next);setError('');validCallback.current(true);
    }catch{setError('请填写有效的'+(kind==='number'?'数值':'JSON'));validCallback.current(false);}}}/>}</div>{error&&<span role="alert" className="text-xs text-error">{error}</span>}</div>;
}

export function ConversationEditor({turns,onChange,onValid}:{turns:ConversationTurn[];onChange:(turns:ConversationTurn[])=>void;onValid:(valid:boolean)=>void}){
  const invalid=useRef(new Set<string>());
  const keys=useRef(new Map<string,{tools:string[]}>());
  const mark=(key:string,valid:boolean)=>{if(valid)invalid.current.delete(key);else invalid.current.add(key);onValid(invalid.current.size===0);};
  const update=(id:string,patch:Partial<ConversationTurn>)=>onChange(turns.map(turn=>turn.id===id?{...turn,...patch}:turn));
  const rules=(turn:ConversationTurn,patch:Partial<TurnExpectation>)=>update(turn.id,{expectation:{...emptyRules,...turn.expectation,...patch}});
  return <div className="grid gap-4" aria-label="逐轮配置">
    <p className="text-xs text-foreground-muted">同一会话中至少两次用户输入才是多轮；一轮内可以包含多次模型调用和工具调用。</p>
    {turns.map((turn,index)=>{
      const expected={...emptyRules,...turn.expectation};
      const ids=keys.current.get(turn.id)||{tools:[]};keys.current.set(turn.id,ids);
      while(ids.tools.length<expected.requiredTools.length)ids.tools.push(safeUUID());
      const removeKey=(kind:'tools',index:number)=>{const [id]=ids[kind].splice(index,1);for(const key of invalid.current)if(key.includes(':'+id+':'))invalid.current.delete(key);onValid(invalid.current.size===0);};
      const changeTool=(at:number,patch:Partial<TurnExpectation['requiredTools'][number]>)=>rules(turn,{requiredTools:expected.requiredTools.map((tool,i)=>i===at?{...tool,...patch}:tool)});
      const legacy=hasLegacyTurnRules(expected);
      return <section key={turn.id} className="grid gap-3 rounded-md border border-border p-3">
        <div className="flex items-center justify-between"><strong className="text-sm">第 {index+1} 轮</strong><div className="flex gap-2">
          {index>0&&<button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" onClick={()=>{const next=[...turns];[next[index-1],next[index]]=[next[index],next[index-1]];onChange(next);}}>上移</button>}
          {turns.length>1&&<button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" onClick={()=>{for(const key of invalid.current)if(key.startsWith(turn.id+':'))invalid.current.delete(key);onChange(turns.filter(t=>t.id!==turn.id));onValid(invalid.current.size===0);}}>删除本轮</button>}
        </div></div>
        <label className="grid gap-1 text-xs">用户输入<Textarea aria-label={`第${index+1}轮输入`} value={turn.input} onChange={e=>update(turn.id,{input:e.target.value})}/></label>
        <label className="grid gap-1 text-xs">预期输出<Textarea aria-label={`第${index+1}轮预期输出`} value={turn.expectedOutput} onChange={e=>update(turn.id,{expectedOutput:e.target.value})}/></label>
        <label className="grid gap-1 text-xs">输出匹配方式{legacy?<span className="text-foreground-muted">历史规则，转换后可选择匹配方式</span>:<Select modal={false} contentClassName="z-[1200]" aria-label={`第${index+1}轮输出匹配方式`} value={expected.outputMatch||'legacy'} options={[...(!expected.outputMatch?[{value:'legacy',label:'历史模式（预期输出不参与逐轮匹配）'}]:[]),{value:'exact',label:'精确匹配'},{value:'contains',label:'包含文本'}]} onChange={value=>{if(value!=='legacy')rules(turn,{outputMatch:value as 'exact'|'contains'});}}/>}</label>
        <p className="text-xs text-foreground-muted">精确匹配要求整段回复逐字一致；包含文本要求回复中出现完整的预期文本。区分大小写和空白，不调用模型。留空则不检查本轮输出。</p>
        {legacy&&<div className="grid gap-2 rounded border border-border p-3 text-xs">
          <p>本轮保留历史规则，仍按原规则评分。改用简化规则会移除以下高级约束，并将原“必须包含”文本用作本轮预期输出；保存草稿、发布新版本后生效，旧版本保持不变。</p>
          <details><summary className="cursor-pointer">查看保留的历史规则</summary><ul className="mt-2 grid list-disc gap-1 pl-4">
            {expected.contains!==undefined&&<li>必须包含：{expected.contains}</li>}{expected.pattern&&<li>正则：{expected.pattern}</li>}{expected.state&&<li>业务状态：{expected.state}</li>}{expected.toolOrder.length>0&&<li>工具顺序：{expected.toolOrder.join(' → ')}</li>}{expected.fields.map((field,i)=><li key={i}>输出字段：{field.path}；{JSON.stringify(field)}</li>)}
          </ul></details>
          <button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" onClick={()=>update(turn.id,simplifyConversationTurn(turn))}>改用简化规则</button>
        </div>}
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs">预期使用的 Skill<Input aria-label="预期使用的 Skill" placeholder="Skill 名称，可选" value={expected.expectedSkill||''} onChange={e=>rules(turn,{expectedSkill:e.target.value.trim()||undefined})}/><span className="text-foreground-muted">检查本轮实际成功加载的 Skill，不从回答、提示词或业务字段推断。缺少加载证据时显示未评完整。</span></label>
          <fieldset className="grid gap-3 rounded border border-border p-2"><legend className="text-xs">必须调用的工具与参数</legend>
            {expected.requiredTools.map((tool,toolIndex)=><div key={ids.tools[toolIndex]} className="grid gap-2 border-b border-border pb-2"><Input aria-label="工具名称" placeholder="工具名称" value={tool.name} onChange={e=>changeTool(toolIndex,{name:e.target.value})}/>
              {Object.entries(tool.arguments||{}).map(([key,value])=><div key={key} className="grid grid-cols-[1fr_2fr_auto] items-end gap-2">
                <label className="grid gap-1 text-xs">参数名<Input aria-label="参数名" defaultValue={key} onBlur={e=>{const name=e.target.value.trim();if(!name||name===key||Object.hasOwn(tool.arguments||{},name)){e.target.value=key;return;}const args={...tool.arguments};delete args[key];args[name]=value;changeTool(toolIndex,{arguments:args});}}/></label>
                <label className="grid gap-1 text-xs">期望参数值<TypedValue value={value} onChange={v=>changeTool(toolIndex,{arguments:{...tool.arguments,[key]:v}})} onValid={valid=>mark(`${turn.id}:${ids.tools[toolIndex]}:${key}`,valid)}/></label>
                <button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" onClick={()=>{const args={...tool.arguments};delete args[key];changeTool(toolIndex,{arguments:args});}}>移除参数</button>
              </div>)}
              <div className="flex gap-2"><button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" onClick={()=>{let name='parameter';while(Object.hasOwn(tool.arguments||{},name))name+='1';changeTool(toolIndex,{arguments:{...tool.arguments,[name]:''}});}}>添加参数</button><button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" onClick={()=>{removeKey('tools',toolIndex);rules(turn,{requiredTools:expected.requiredTools.filter((_,i)=>i!==toolIndex)});}}>移除工具</button></div>
            </div>)}
            <button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" onClick={()=>rules(turn,{requiredTools:[...expected.requiredTools,{name:'',arguments:{}}]})}><Plus size={12}/>添加工具要求</button>
          </fieldset>
          <label className="grid gap-1 text-xs">禁止工具（逗号分隔）<NameList value={expected.forbiddenTools} onChange={forbiddenTools=>rules(turn,{forbiddenTools})}/></label>
        </div>
      </section>;
    })}
    <button type="button" className="ai-btn-s inline-flex w-fit items-center gap-1.5 justify-self-start" disabled={turns.length>=20} onClick={()=>onChange([...turns,newConversationTurn()])}><Plus size={12}/>添加一轮</button>
  </div>;
}
