/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { withEvaluatorCatalogFields, type DatasetField, type DatasetCase } from '@/lib/agent-dataset-model';
import { canonicalAssetJson } from './canonical';
import type { AssetDraft } from './types';
import { prismaRaw, db } from '@/lib/storage/prisma';
import { PrismaClient } from '@prisma/client';
import { findAgentDataset, normalizeCases, buildAgentDatasetProjection, recordPublishedDatasetVersion, validateCasesForKind, type AgentDatasetRecord } from '@/server/agent_datasets_storage';
import { readUserCustomEvaluators, evaluatorVersionContent, writeUserCustomEvaluatorsInTransaction } from '@/server/user_evaluators_storage';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { isBuiltinReliabilityDataset } from '@/lib/agent-dataset-builtin';
import { normalizeEvaluatorSkillCards } from '@/lib/evaluators/evaluator-skill-service';
import { findUnsupportedCustomEvaluatorVariables, isValidCustomEvaluatorName, type EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { listFaultModeIds } from '@/lib/reliability/fault-modes';
import { normalizeTraceCases } from '@/lib/trace-datasets/contracts';
import { agentAssetBusinessId } from './identity';
import { EvaluationAssetError, type AssetIdentity, type AssetKind, type AssetTransaction, type AssetQueries } from './types';
import { createDatasetDraft, ensureAssetVersion, getAssetVersion, getDatasetDraft, listAssetVersions, publishDatasetDraft, revertDatasetDraftCase, saveDatasetDraftCase, withEvaluationAssetTransaction } from './store';

export function assertVersionBackend():void {
  if(process.env.DB_HOST || !(db.getClient() instanceof PrismaClient))throw new EvaluationAssetError('当前数据库保留原有流程，首版资产版本管理需要 SQLite。',501,'ASSET_BACKEND_UNSUPPORTED');
}

export { datasetVersionContent } from '@/server/agent_datasets_storage';

function agentDefinition(businessId:string):Record<string,unknown> {
  let pair:unknown;try{pair=JSON.parse(businessId);}catch{throw new EvaluationAssetError('Agent 身份无效');}
  if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string')||agentAssetBusinessId(pair[0],pair[1])!==businessId)throw new EvaluationAssetError('Agent 平台或名称无效');
  return {platform:pair[0],agentName:pair[1]};
}

async function sourceIdentity(user:string,kind:AssetKind,businessId:string):Promise<AssetIdentity> {
  if(kind==='dataset'){
    const source=await findAgentDataset(user,businessId);
    if(!source){
      const own=await prismaRaw.evaluationAssetHead.findUnique({where:{user_kind_businessId:{user,kind,businessId}}});
      if(own)return {user,kind,businessId};
      throw new EvaluationAssetError('数据集不存在或无权访问',404);
    }
    return {user:source.user,kind,businessId};
  }
  if(kind==='agent')agentDefinition(businessId);
  return {user,kind,businessId};
}

export async function syncPublishedAsset(tx:AssetTransaction,identity:AssetIdentity) {
  let content:Record<string,unknown>;
  if(identity.kind==='dataset'){
    const row=await tx.agentEvalDataset.findFirst({where:{id:identity.businessId,user:identity.user}});
    if(!row)return null;
    if(row.generationSource==='trace' && row.generationStatus!=='published')throw new EvaluationAssetError('数据集尚未完成生成发布',409);
    return recordPublishedDatasetVersion(tx,row,'existing');
  }else if(identity.kind==='evaluator'){
    const row=await tx.customEvaluatorList.findUnique({where:{user:identity.user}});
    const cards=row?JSON.parse(row.itemsJson):[];
    const card=cards.find((card:{id:string})=>card.id===identity.businessId)||presetEvaluators.find(card=>card.id===identity.businessId);
    if(!card)return null;
    content=evaluatorVersionContent(card);
  }else{
    const head=await tx.evaluationAssetHead.findUnique({where:{user_kind_businessId:identity}});
    if(head?.publishedVersion)return null;
    content=agentDefinition(identity.businessId);
  }
  return ensureAssetVersion(tx,{...identity,content,source:'existing'});
}

export async function assetVersionView(user:string,kind:AssetKind,businessId:string,versionId?:string) {
  assertVersionBackend();
  const identity=await sourceIdentity(user,kind,businessId);
  await withEvaluationAssetTransaction(tx=>syncPublishedAsset(tx,identity));
  const result=await listAssetVersions(prismaRaw as unknown as AssetQueries,identity);
  if(!result.head)throw new EvaluationAssetError('资产不存在或无权访问',404);
  const selected=versionId || result.versions.find(v=>v.version===result.head!.publishedVersion)?.id;
  const selectedVersion=selected?await getAssetVersion(prismaRaw as unknown as AssetQueries,{user:identity.user,versionId:selected,kind,businessId}):null;
  const draft=kind==='dataset'&&identity.user===user?await getDatasetDraft(prismaRaw as unknown as AssetQueries,{user,businessId}):null;
  const source=kind==='dataset'?await findAgentDataset(user,businessId):null;
  return {...result,selectedVersion,draft,readOnly:result.head.archived || identity.user!==user || kind==='evaluator'&&!businessId.startsWith('custom-') || kind==='dataset'&&(!source||source.datasetKind==='benchmark'||isBuiltinReliabilityDataset(source))};
}

async function editableDataset(user:string,businessId:string):Promise<AgentDatasetRecord> {
  const source=await findAgentDataset(user,businessId);
  if(!source||source.user!==user)throw new EvaluationAssetError('数据集不存在或无权修改',404);
  if(source.datasetKind==='benchmark'||isBuiltinReliabilityDataset(source))throw new EvaluationAssetError('系统内置数据集只读',403);
  if(source.generationSource==='trace'&&source.generationStatus!=='published')throw new EvaluationAssetError('数据集尚未发布',409);
  return source;
}

async function validateDraftCases(content:Record<string,unknown>,source:Pick<AgentDatasetRecord,'datasetKind'|'generationSource'>) {
  const cases=source.generationSource==='trace'?normalizeTraceCases(content.cases):normalizeCases(content.cases);
  const basic=validateCasesForKind(cases,source.datasetKind);
  if(basic.length)throw new EvaluationAssetError(basic[0].message,422);
  if(source.datasetKind==='reliability'){
    const errors=validateCasesForKind(cases,source.datasetKind,{allowedFaultModeIds:await listFaultModeIds()});
    if(errors.length)throw new EvaluationAssetError(errors[0].message,422);
  }
  return cases;
}

function validateEvaluatorPublication(card:EvaluatorCard,other:EvaluatorCard[]) {
  if(!['LLM','Code','Custom RPC'].includes(card.evaluatorType))throw new EvaluationAssetError('评估器类型无效');
  if(card.evaluatorType!=='LLM')return;
  if(!isValidCustomEvaluatorName(card.name))throw new EvaluationAssetError('评估器名称无效');
  if(other.some(item=>item.evaluatorType==='LLM'&&item.name===card.name))throw new EvaluationAssetError('评估器名称重复');
  if(!card.llmConfig?.systemPrompt?.trim())throw new EvaluationAssetError('systemPrompt 必填');
  const variables=[...findUnsupportedCustomEvaluatorVariables(card.llmConfig.systemPrompt),...findUnsupportedCustomEvaluatorVariables(card.llmConfig.userPrompt || '')];
  if(variables.length)throw new EvaluationAssetError('评估器包含不支持的变量：'+variables.join(', '));
}

async function publishEvaluator(user:string,businessId:string,body:Record<string,unknown>) {
  if(!businessId.startsWith('custom-'))throw new EvaluationAssetError('预置评估器只读',403);
  if(!body.card||typeof body.card!=='object'||Array.isArray(body.card))throw new EvaluationAssetError('评估器定义必填');
  const current=await readUserCustomEvaluators(user) as EvaluatorCard[];
  const previous=current.find(card=>card.id===businessId);
  if(!previous)throw new EvaluationAssetError('评估器不存在或无权修改',404);
  const submitted={...previous,...body.card,id:businessId,source:'custom'} as EvaluatorCard;
  if((body.card as Record<string,unknown>).id!==businessId)throw new EvaluationAssetError('评估器标识不匹配');
  validateEvaluatorPublication(submitted,current.filter(card=>card.id!==businessId));
  const [normalized]=await normalizeEvaluatorSkillCards(user,[submitted],[previous]);
  const baseVersion=Number(body.baseVersion),revision=Number(body.revision);
  if(!Number.isInteger(baseVersion)||baseVersion<1||!Number.isInteger(revision)||revision<1)throw new EvaluationAssetError('评估器基线版本和 revision 必填');
  const result=await withEvaluationAssetTransaction(async tx=>{
    const identity={user,kind:'evaluator' as const,businessId};
    await syncPublishedAsset(tx,identity);
    const head=await tx.evaluationAssetHead.findUnique({where:{user_kind_businessId:identity}});
    if(!head||head.archived)throw new EvaluationAssetError('评估器不存在或无权修改',404);
    if(head.publishedVersion!==baseVersion||head.revision!==revision)throw new EvaluationAssetError('评估器版本已变化，请刷新后重试',409,'ASSET_CONFLICT');
    const row=await tx.customEvaluatorList.findUnique({where:{user}});
    const cards=(row?JSON.parse(row.itemsJson):[]) as EvaluatorCard[];
    if(!cards.some(card=>card.id===businessId))throw new EvaluationAssetError('评估器已删除',409);
    validateEvaluatorPublication(normalized,cards.filter(card=>card.id!==businessId));
    const incoming=cards.map(card=>card.id===businessId?normalized:card);
    const published=await writeUserCustomEvaluatorsInTransaction(tx,user,incoming,{evaluatorId:businessId,note:String(body.note || '')});
    return published.get(businessId)!;
  });
  const {invalidateCustomEvaluatorCache,syncCustomEvaluatorRegisteredAgents}=await import('@/lib/engine/evaluation/custom-llm-evaluator');
  invalidateCustomEvaluatorCache();
  await syncCustomEvaluatorRegisteredAgents(user,await readUserCustomEvaluators(user) as EvaluatorCard[]).catch(()=>undefined);
  return result;
}

function normalizedDraftCase(value:unknown,caseId:string):Record<string,unknown>|null {
  if(value===null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new EvaluationAssetError('Case 内容无效');
  const input=value as Record<string,unknown>;
  if(input.id!==caseId)throw new EvaluationAssetError('Case 标识不匹配');
  const normalized=normalizeCases([{...input,input:String(input.input || ''),expectedOutput:String(input.expectedOutput || '')}])[0];
  if(!normalized)throw new EvaluationAssetError('Case 内容为空');
  return {...normalized};
}

async function withDraftCatalogFields(tx:AssetTransaction,draft:AssetDraft,trace:boolean):Promise<AssetDraft> {
  if(trace)return draft;
  const base=await tx.evaluationAssetVersion.findUniqueOrThrow({where:{assetId_version:{assetId:draft.assetId,version:draft.baseVersion}}});
  const fields=withEvaluatorCatalogFields(JSON.parse(base.contentJson).fields as DatasetField[],draft.content.cases as DatasetCase[]);
  const content={...draft.content,fields};
  await tx.evaluationAssetDraft.update({where:{assetId:draft.assetId},data:{contentJson:canonicalAssetJson(content)}});
  return {...draft,content};
}

export async function mutateAsset(user:string,body:Record<string,unknown>) {
  assertVersionBackend();
  const action=String(body.action || ''),businessId=String(body.businessId || '');
  if(action==='agent-publish'){
    const platform=String(body.platform || ''),agentName=String(body.agentName || ''),note=String(body.note || '').trim(),requestId=String(body.requestId || '');
    if(!note||note.length>2000||!requestId||requestId.length>200)throw new EvaluationAssetError('请填写版本变更说明及提交标识');
    const key=agentAssetBusinessId(platform,agentName);
    return withEvaluationAssetTransaction(tx=>ensureAssetVersion(tx,{user,kind:'agent',businessId:key,note,source:'declaration',content:{...agentDefinition(key),changeDescription:note,declarationId:requestId,...(body.externalVersion?{externalVersion:String(body.externalVersion).slice(0,200)}:{})}}));
  }
  if(action==='evaluator-publish')return publishEvaluator(user,businessId,body);
  if(!['draft-create','case-save','case-revert','draft-discard','dataset-publish'].includes(action))throw new EvaluationAssetError('不支持的资产操作');
  await editableDataset(user,businessId);
  return withEvaluationAssetTransaction(async tx=>{
    const source=await tx.agentEvalDataset.findFirst({where:{id:businessId,user},include:{generationJob:{select:{status:true}}}});
    if(!source)throw new EvaluationAssetError('数据集不存在或无权修改',404);
    const metadata={name:source.name,tags:JSON.parse(source.tagsJson || '[]')};
    if(source.datasetKind==='benchmark'||isBuiltinReliabilityDataset(metadata))throw new EvaluationAssetError('系统内置数据集只读',403);
    if(source.generationSource==='trace'&&(source.generationStatus!=='published'||source.generationJob&&source.generationJob.status!=='succeeded'))throw new EvaluationAssetError('数据集尚未发布',409);
    await syncPublishedAsset(tx,{user,kind:'dataset',businessId});
    const identity={user,businessId};
    if(action==='draft-create')return {draft:await createDatasetDraft(tx,identity)};
    const revision=Number(body.revision);
    if(!Number.isInteger(revision)||revision<1)throw new EvaluationAssetError('草稿 revision 无效');
    if(action==='draft-discard'){
      const draft=await getDatasetDraft(tx,identity);
      if(!draft||draft.revision!==revision)throw new EvaluationAssetError('草稿已变化，请刷新后重试',409,'ASSET_CONFLICT');
      const removed=await tx.evaluationAssetDraft.deleteMany({where:{assetId:draft.assetId,revision}});
      if(!removed.count)throw new EvaluationAssetError('草稿丢弃冲突，请刷新后重试',409,'ASSET_CONFLICT');
      return {discarded:true};
    }
    if(action==='case-save'){
      let value=normalizedDraftCase(body.case,String(body.caseId || ''));
      if(value)value=(await validateDraftCases({cases:[value]},source as unknown as AgentDatasetRecord))[0] as unknown as Record<string,unknown>;
      return {draft:await withDraftCatalogFields(tx,await saveDatasetDraftCase(tx,{...identity,caseId:String(body.caseId || ''),expectedRevision:revision,case:value}),source.generationSource==='trace')};
    }
    if(action==='case-revert')return {draft:await withDraftCatalogFields(tx,await revertDatasetDraftCase(tx,{...identity,caseId:String(body.caseId || ''),expectedRevision:revision}),source.generationSource==='trace')};
    return publishDatasetDraft(tx,{...identity,expectedRevision:revision,note:String(body.note || ''),project:async(tx,content)=>{
      const cases=await validateDraftCases(content,source as unknown as AgentDatasetRecord);
      await tx.agentEvalDataset.update({where:{id:businessId},data:{fieldsJson:JSON.stringify(content.fields),casesJson:JSON.stringify(cases),...buildAgentDatasetProjection(cases,source.generationSource==='trace'),projectionReady:true,updatedAt:new Date()}});
    }});
  });
}
