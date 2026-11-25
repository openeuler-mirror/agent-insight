/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import type {EvaluatorCard} from './custom-evaluator-model';
export interface EvaluatorVersionField {key:string;label:string;value:string;comparisonValue:string}
export interface EvaluatorVersionChange {key:string;label:string;before:string;after:string}
function ordered(value:unknown):unknown {
  if(Array.isArray(value))return value.map(ordered);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)]));
  return value;
}
function display(value:unknown):string {
  if(value===undefined||value===null||value==='')return '未配置';
  return typeof value==='string'?value:JSON.stringify(ordered(value),null,2);
}
export function evaluatorVersionFields(card:EvaluatorCard):EvaluatorVersionField[]{
  const values:Array<[string,string,unknown]>=[
    ['name','名称',card.name],['description','描述',card.description],['evaluatorType','类型',card.evaluatorType],
    ['source','来源',card.source],['category','评测分类',card.category||'res'],['targetTypes','评测对象',card.targetTypes||[]],
    ['objectives','评估目标',card.objectives||[]],['scenarios','应用场景',card.scenarios||[]],['runMode','运行方式',card.runMode],
    ['scoreRange','评分范围',card.scoreRange],['mappedMetrics','评测指标',card.mappedMetrics||[]],['status','状态',card.status],
    ['pointsDef','评分点',card.pointsDef||[]],
  ];
  if(card.evaluatorType==='LLM')values.push(
    ['llm.model','模型引用',card.llmConfig?.model],['llm.systemPrompt','System Prompt',card.llmConfig?.systemPrompt],
    ['llm.userPrompt','User Prompt',card.llmConfig?.userPrompt],
    ['llm.skills','Skills',card.llmConfig?.skills?.map(skill=>'source' in skill?{name:skill.name,source:skill.source,snapshotHash:skill.snapshotHash,fileCount:skill.fileCount,totalBytes:skill.totalBytes}:{name:skill.name,source:skill.kind==='library'?{kind:skill.kind,owner:skill.sourceOwner,version:skill.version}:{kind:skill.kind},...('fileCount' in skill?{fileCount:skill.fileCount}:{})})||[]],
  );
  if(card.evaluatorType==='Code')values.push(['code.language','代码语言',card.codeConfig?.language],['code.scoreMode','代码评分方式',card.codeConfig?.scoreMode],['code.sourceCode','代码内容',card.codeConfig?.sourceCode]);
  values.push(['runtimeNote','实现说明',card.runtimeNote],['runtimeHref','运行入口',card.runtimeHref],['outputDescription','输出说明',card.outputDescription]);
  return values.map(([key,label,value])=>({key,label,value:display(value),comparisonValue:JSON.stringify(ordered(value===undefined||value===null||value===''?null:value))}));
}
export function compareEvaluatorVersions(before:EvaluatorCard,after:EvaluatorCard):EvaluatorVersionChange[]{
  const previous=evaluatorVersionFields(before),next=evaluatorVersionFields(after);
  const a=new Map(previous.map(field=>[field.key,field])),b=new Map(next.map(field=>[field.key,field]));
  return [...new Set([...a.keys(),...b.keys()])].flatMap(key=>{
    const left=a.get(key),right=b.get(key);
    const show=(field:EvaluatorVersionField|undefined)=>field?.value==='未配置'&&field.comparisonValue!=='null'?'文本：未配置':field?.value||'未配置';
    const old=show(left),current=show(right);
    return (left?.comparisonValue||'null')===(right?.comparisonValue||'null')?[]:[{key,label:(right||left)!.label,before:old,after:current}];
  });
}
