/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

'use client';

import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Select} from '@/components/ui/select';
import type {ConversationTurn,TurnExpectation} from '@/lib/evaluation-conversation';
import {safeUUID} from '@/lib/safe-uuid';

const emptyRules:TurnExpectation={requiredTools:[],forbiddenTools:[],toolOrder:[],fields:[],blocking:true};
export function newConversationTurn(input='',expectedOutput=''):ConversationTurn{return{id:safeUUID(),input,expectedOutput,expectation:{...emptyRules}};}

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
  return <div className="grid gap-2"><div className="flex items-center gap-2"><Select value={kind} aria-label="期望值类型" options={[{value:'string',label:'文本'},{value:'number',label:'数值'},{value:'boolean',label:'布尔'},{value:'json',label:'对象/数组'}]} onChange={type=>onChange(type==='number'?0:type==='boolean'?false:type==='json'?{}:'')}/>
    {kind==='boolean'?<Select value={String(value)} aria-label="期望布尔值" options={[{value:'true',label:'是'},{value:'false',label:'否'}]} onChange={v=>onChange(v==='true')}/>:<Input aria-label="期望值" value={text} onChange={e=>{setText(e.target.value);try{
      let next:unknown=e.target.value;
      if(kind==='number'){next=Number(e.target.value);if(!e.target.value.trim()||!Number.isFinite(next))throw Error();}
      if(kind==='json')next=JSON.parse(e.target.value);
      onChange(next);setError('');validCallback.current(true);
    }catch{setError('请填写有效的'+(kind==='number'?'数值':'JSON'));validCallback.current(false);}}}/>}</div>{error&&<span role="alert" className="text-xs text-error">{error}</span>}</div>;
}

export function ConversationEditor({turns,onChange,onValid}:{turns:ConversationTurn[];onChange:(turns:ConversationTurn[])=>void;onValid:(valid:boolean)=>void}){
  const invalid=useRef(new Set<string>());
  const keys=useRef(new Map<string,{tools:string[];fields:string[]}>());
  const mark=(key:string,valid:boolean)=>{if(valid)invalid.current.delete(key);else invalid.current.add(key);onValid(invalid.current.size===0);};
  const update=(id:string,patch:Partial<ConversationTurn>)=>onChange(turns.map(turn=>turn.id===id?{...turn,...patch}:turn));
  const rules=(turn:ConversationTurn,patch:Partial<TurnExpectation>)=>update(turn.id,{expectation:{...emptyRules,...turn.expectation,...patch}});
  return <div className="grid gap-4" aria-label="逐轮配置">
    {turns.map((turn,index)=>{
      const expected={...emptyRules,...turn.expectation};
      const ids=keys.current.get(turn.id)||{tools:[],fields:[]};keys.current.set(turn.id,ids);
      while(ids.tools.length<expected.requiredTools.length)ids.tools.push(safeUUID());
      while(ids.fields.length<expected.fields.length)ids.fields.push(safeUUID());
      const removeKey=(kind:'tools'|'fields',index:number)=>{const [id]=ids[kind].splice(index,1);for(const key of invalid.current)if(key.includes(':'+id+':'))invalid.current.delete(key);onValid(invalid.current.size===0);};
      const changeTool=(at:number,patch:Partial<TurnExpectation['requiredTools'][number]>)=>rules(turn,{requiredTools:expected.requiredTools.map((tool,i)=>i===at?{...tool,...patch}:tool)});
      const changeField=(at:number,patch:Partial<TurnExpectation['fields'][number]>)=>rules(turn,{fields:expected.fields.map((field,i)=>i===at?{...field,...patch}:field)});
      return <section key={turn.id} className="grid gap-3 rounded-md border border-border p-3">
        <div className="flex items-center justify-between"><strong className="text-sm">第 {index+1} 轮</strong><div className="flex gap-2">
          {index>0&&<Button type="button" size="sm" variant="ghost" onClick={()=>{const next=[...turns];[next[index-1],next[index]]=[next[index],next[index-1]];onChange(next);}}>上移</Button>}
          {turns.length>1&&<Button type="button" size="sm" variant="ghost" onClick={()=>{for(const key of invalid.current)if(key.startsWith(turn.id+':'))invalid.current.delete(key);onChange(turns.filter(t=>t.id!==turn.id));onValid(invalid.current.size===0);}}>删除本轮</Button>}
        </div></div>
        <label className="grid gap-1 text-xs">用户输入<Textarea aria-label={`第${index+1}轮输入`} value={turn.input} onChange={e=>update(turn.id,{input:e.target.value})}/></label>
        <label className="grid gap-1 text-xs">预期输出<Textarea aria-label={`第${index+1}轮预期输出`} value={turn.expectedOutput} onChange={e=>update(turn.id,{expectedOutput:e.target.value})}/></label>
        <details className="grid gap-3"><summary className="cursor-pointer text-xs font-medium">本轮规则与工具要求</summary><div className="mt-3 grid gap-3">
          <div className="grid grid-cols-2 gap-2">{([['contains','输出必须包含'],['pattern','输出正则'],['expectedSkill','预期 Skill 路由'],['state','预期结束状态']] as const).map(([key,label])=><label key={key} className="grid gap-1 text-xs">{label}<Input aria-label={label} value={expected[key]||''} onChange={e=>rules(turn,{[key]:e.target.value||undefined})}/></label>)}</div>
          <fieldset className="grid gap-3 rounded border border-border p-2"><legend className="text-xs">必须调用的工具与参数</legend>
            {expected.requiredTools.map((tool,toolIndex)=><div key={ids.tools[toolIndex]} className="grid gap-2 border-b border-border pb-2"><Input aria-label="工具名称" placeholder="工具名称" value={tool.name} onChange={e=>changeTool(toolIndex,{name:e.target.value})}/>
              {Object.entries(tool.arguments||{}).map(([key,value])=><div key={key} className="grid grid-cols-[1fr_2fr_auto] items-end gap-2">
                <label className="grid gap-1 text-xs">参数名<Input aria-label="参数名" defaultValue={key} onBlur={e=>{const name=e.target.value.trim();if(!name||name===key||Object.hasOwn(tool.arguments||{},name)){e.target.value=key;return;}const args={...tool.arguments};delete args[key];args[name]=value;changeTool(toolIndex,{arguments:args});}}/></label>
                <label className="grid gap-1 text-xs">期望参数值<TypedValue value={value} onChange={v=>changeTool(toolIndex,{arguments:{...tool.arguments,[key]:v}})} onValid={valid=>mark(`${turn.id}:${ids.tools[toolIndex]}:${key}`,valid)}/></label>
                <Button type="button" size="sm" variant="ghost" onClick={()=>{const args={...tool.arguments};delete args[key];changeTool(toolIndex,{arguments:args});}}>移除</Button>
              </div>)}
              <div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={()=>{let name='parameter';while(Object.hasOwn(tool.arguments||{},name))name+='1';changeTool(toolIndex,{arguments:{...tool.arguments,[name]:''}});}}>添加参数</Button><Button type="button" size="sm" variant="ghost" onClick={()=>{removeKey('tools',toolIndex);rules(turn,{requiredTools:expected.requiredTools.filter((_,i)=>i!==toolIndex)});}}>移除工具</Button></div>
            </div>)}
            <Button type="button" size="sm" variant="outline" onClick={()=>rules(turn,{requiredTools:[...expected.requiredTools,{name:'',arguments:{}}]})}>添加工具要求</Button>
          </fieldset>
          <label className="grid gap-1 text-xs">禁止工具（逗号分隔）<NameList value={expected.forbiddenTools} onChange={forbiddenTools=>rules(turn,{forbiddenTools})}/></label>
          <label className="grid gap-1 text-xs">工具调用顺序（逗号分隔）<NameList value={expected.toolOrder} onChange={toolOrder=>rules(turn,{toolOrder})}/></label>
          <fieldset className="grid gap-3 rounded border border-border p-2"><legend className="text-xs">输出字段约束</legend>{expected.fields.map((field,fieldIndex)=><div key={ids.fields[fieldIndex]} className="grid gap-2 border-b border-border pb-2">
            <div className="flex flex-wrap items-center gap-2"><Input aria-label="字段路径" placeholder="字段路径，如 result.amount" value={field.path} onChange={e=>changeField(fieldIndex,{path:e.target.value})}/><Select aria-label="字段类型" value={field.type||''} options={[{value:'',label:'不限制类型'},...(['string','number','boolean','array','object'] as const).map(value=>({value,label:value}))]} onChange={type=>changeField(fieldIndex,{type:type as typeof field.type || undefined})}/><label className="text-xs"><input type="checkbox" checked={field.required} onChange={e=>changeField(fieldIndex,{required:e.target.checked})}/>必填</label></div>
            <div className="flex gap-2"><Input type="number" aria-label="最小值" placeholder="最小值" value={field.min??''} onChange={e=>changeField(fieldIndex,{min:e.target.value===''?undefined:Number(e.target.value)})}/><Input type="number" aria-label="最大值" placeholder="最大值" value={field.max??''} onChange={e=>changeField(fieldIndex,{max:e.target.value===''?undefined:Number(e.target.value)})}/></div>
            <label className="text-xs"><input type="checkbox" checked={field.equals!==undefined} onChange={e=>changeField(fieldIndex,{equals:e.target.checked?'':undefined})}/> 必须等于指定值</label>{field.equals!==undefined&&<TypedValue value={field.equals} onChange={equals=>changeField(fieldIndex,{equals})} onValid={valid=>mark(`${turn.id}:${ids.fields[fieldIndex]}:equals`,valid)}/>}<Button type="button" variant="ghost" size="sm" onClick={()=>{removeKey('fields',fieldIndex);rules(turn,{fields:expected.fields.filter((_,i)=>i!==fieldIndex)});}}>移除字段</Button>
          </div>)}<Button type="button" variant="outline" size="sm" onClick={()=>rules(turn,{fields:[...expected.fields,{path:'',required:true}]})}>添加字段约束</Button></fieldset>
          <label className="text-xs"><input type="checkbox" checked={expected.blocking} onChange={e=>rules(turn,{blocking:e.target.checked})}/> 本轮规则属于业务红线</label>
        </div></details>
      </section>;
    })}
    <Button type="button" size="sm" variant="outline" disabled={turns.length>=20} onClick={()=>onChange([...turns,newConversationTurn()])}>添加一轮</Button>
  </div>;
}
