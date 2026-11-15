import {createHash} from 'node:crypto';
import type {Experiment,SkillOptimizationRecord} from '@prisma/client';
import {prismaRaw} from '@/lib/storage/prisma';
import {generateExperimentTraces} from '@/lib/engine/experiment/trace-generation';
import {evaluateEvalExperimentCase} from '@/lib/engine/experiment/run-experiment';
import {contentHash,parseStored} from '@/lib/diagnosis/contracts';
import {datasetCaseContentHash,matchesLegacyDatasetText} from '@/lib/engine/experiment/dataset-case-snapshot';
import type {SkillExecutionTarget} from '@/lib/skill-workbench/execution-target';
import type {AgentDatasetRecord} from '@/server/agent_datasets_storage';
import {requireCoreExperimentContext,runWithCoreExperimentContext} from './experiments';
import {readCoreDiagnosis,verifyCoreDiagnosisSource} from './diagnosis-consumer';
import {withCoreDatasets,coreDatasetRequest} from './datasets';

type Result={id:string;evaluatorId:string;status:string;score:number|null;humanScore:number|null;updatedAt:string;verdict:string|null};
type Case={id:string;input:string;datasetInput:string|null;referenceOutput:string|null;actualOutput:string;executionId:string|null;caseValuesJson:string|null;results:Result[]};
type Source=Experiment&{cases:Case[]};
export async function retestCoreDiagnosisCase(record:SkillOptimizationRecord,_source:Experiment,files:Record<string,string>){
 const context=requireCoreExperimentContext();const ref=parseStored<Array<{type:string;id:string}>>(record.sourceRefsJson,[]).find(item=>item.type==='diagnosis');
 if(!ref)throw new Error('诊断来源已失效，无法按原实验配置复测');
 const run=await readCoreDiagnosis(ref.id);if(run.status!=='done'||run.experiment_id!==_source.id)throw new Error('诊断来源已失效，无法按原实验配置复测');
 await verifyCoreDiagnosisSource(run.id);
 if(run.source_model_selection_consistent!==true)throw new Error('来源评测使用了不同模型配置，无法保证同配置复测');
 return runWithCoreExperimentContext({...context,frozenStartModelSelection:run.source_model_selection??null},()=>executeRetest(record,_source,files,run));
}
async function executeRetest(record:SkillOptimizationRecord,_source:Experiment,files:Record<string,string>,run:Awaited<ReturnType<typeof readCoreDiagnosis>>){
 const context=requireCoreExperimentContext();
 const source=(await context.rpc('read',{experiment_id:_source.id}) as {experiment:Source}).experiment;
 const frozen=run.snapshot;
 const config=parseStored<{datasetId?:string;caseIds?:string[];executionTarget?:SkillExecutionTarget&{timeoutSeconds?:number};customEvaluatorSnapshots?:{cards?:Record<string,unknown>};coreAssets?:{releases?:{dataset?:string}}}>(source.configSnapshotJson,{});
 const target=config.executionTarget;const evaluatorIds=parseStored<string[]>(source.evaluatorIdsJson,[]);
 if(!config.datasetId||!config.caseIds?.length||!target?.workerId||!target.model||!target.timeoutSeconds||!evaluatorIds.length||source.type!=='single'||source.status!=='done'||source.deletedAt)throw new Error('来源实验缺少可复测配置或尚未完成');
 if(contentHash(config)!==contentHash(frozen.experiment.config))throw new Error('诊断后执行配置发生变化');
 if(contentHash(parseStored(source.evaluatorConfigsJson,{}))!==contentHash(frozen.experiment.evaluatorConfigs)||!frozen.experiment.evaluatorIds||contentHash(evaluatorIds)!==contentHash(frozen.experiment.evaluatorIds))throw new Error('诊断后评估器配置发生变化');
 if(evaluatorIds.some(id=>id.startsWith('custom-')&&!config.customEvaluatorSnapshots?.cards?.[id]))throw new Error('来源实验缺少自定义评估器快照');
 const release=config.coreAssets?.releases?.dataset;if(!release)throw new Error('来源实验缺少不可变数据集版本');
 const getDataset=()=>withCoreDatasets(context.request,()=>coreDatasetRequest<{dataset:AgentDatasetRecord}>('get',{dataset_id:config.datasetId,version:release}),context.options);
 const dataset=(await getDataset()).dataset;if(!dataset)throw new Error('来源数据集不存在，无法复测');
 const fingerprint=(value:Source)=>contentHash({config:value.configSnapshotJson,evaluatorIds:value.evaluatorIdsJson,evaluatorConfigs:value.evaluatorConfigsJson,status:value.status,deletedAt:value.deletedAt,cases:value.cases.map(row=>({id:row.id,input:row.input,referenceOutput:row.referenceOutput,executionId:row.executionId,datasetInput:row.datasetInput,actualOutput:row.actualOutput,caseValuesJson:row.caseValuesJson,results:row.results.map(result=>({id:result.id,updatedAt:result.updatedAt})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id))});
 const sourceFingerprint=fingerprint(source);
 const cases=config.caseIds.map(id=>{
  const datasetCase=dataset.cases.find(item=>item.id===id);if(!datasetCase)throw new Error(`来源 Case 已删除：${id}`);
  const rows=source.cases.filter(row=>parseStored<{__agentInsightDatasetCase?:{caseId?:string}}>(row.caseValuesJson,{}).__agentInsightDatasetCase?.caseId===id);
  if(!rows.length)throw new Error(`来源 Case 绑定缺失：${id}`);if(rows.length!==1)throw new Error(`来源 Case 绑定不唯一：${id}`);const row=rows[0];
  if(!row.executionId)throw new Error(`原执行 Trace 缺失：${id}`);
  if(row.id===run.case_id){if(row.input!==frozen.case.input)throw new Error('诊断后任务输入发生变化');if((row.referenceOutput||'')!==(frozen.case.referenceOutput||''))throw new Error('诊断后预期答案发生变化');if(row.executionId!==frozen.execution.id||row.actualOutput!==frozen.case.actualOutput)throw new Error('诊断后执行记录发生变化');}
  const binding=parseStored<{__agentInsightDatasetCase?:{datasetId?:string;contentHash?:string}}>(row.caseValuesJson,{}).__agentInsightDatasetCase;
  if(binding?.datasetId&&binding.datasetId!==config.datasetId)throw new Error(`来源数据集绑定不一致：${id}`);
  const matches=binding?.contentHash?(a:string,b:string)=>a===b:matchesLegacyDatasetText;
  if(!matches(row.datasetInput||row.input,datasetCase.input))throw new Error(`任务输入发生变化：${id}`);
  if(!matches(row.referenceOutput||'',datasetCase.expectedOutput||''))throw new Error(`预期答案内容发生变化：${id}`);
  if(binding?.contentHash&&binding.contentHash!==datasetCaseContentHash(datasetCase))throw new Error(`数据集 Case 内容或评估上下文发生变化：${id}`);
  const baseline=evaluatorIds.map(id=>{const result=row.results.find(item=>item.evaluatorId===id);if(!result||result.status!=='done'||result.score===null||result.humanScore!==null)throw new Error('缺少同口径机器评分，或基线包含人工改分，需要人工复核');if(row.id===run.case_id&&frozen.results.some(item=>item.id===result.id&&item.updatedAt!==result.updatedAt))throw new Error('诊断后来源评测已变化');return result.score;});
  return {row,datasetCase,baseline,caseId:'diagnosis-case-'+createHash('sha256').update(JSON.stringify([context.actor.workspace,context.actor.principal,context.operationKey,record.id,record.candidateContentHash,row.id])).digest('hex').slice(0,40)};
 });
 if(!cases.some(item=>item.row.id===run.case_id))throw new Error('来源 Case 未纳入复测');
 const claimed=await prismaRaw.skillOptimizationRecord.updateMany({where:{id:record.id,status:record.status,candidateContentHash:record.candidateContentHash},data:{status:'retesting'}});if(!claimed.count)throw new Error('复测状态已变化');
 let experimentId:string|null=null;let baseSum=0,candidateSum=0,measured=0,passed=true;
 try{
  const created=await context.rpc('create',{experiment:{name:source.name+' · 诊断候选复测',type:source.type,agentName:source.agentName,evaluatorIdsJson:source.evaluatorIdsJson,evaluatorConfigsJson:source.evaluatorConfigsJson,sourceExperimentId:source.id,optimizationRecordId:record.id,skillName:record.skillName,skillVersion:record.baseVersion,preset:'retest',configSnapshotJson:JSON.stringify({...config,candidateHash:record.candidateContentHash,coreDiagnosisSource:{id:run.id,inputHash:run.input_hash}}),cases:cases.map(({row,caseId})=>({id:caseId,input:row.input,datasetInput:row.datasetInput,actualOutput:'',referenceOutput:row.referenceOutput,caseValuesJson:row.caseValuesJson}))},operation_key:context.operationKey+':diagnosis-retest-create',operation_request:{record_id:record.id,candidate_content_hash:record.candidateContentHash,diagnosis_id:run.id,diagnosis_input_hash:run.input_hash,source_fingerprint:sourceFingerprint}}) as {experiment:{id:string}};
  experimentId=created.experiment.id;await prismaRaw.skillOptimizationRecord.update({where:{id:record.id},data:{retestExperimentId:experimentId}});
  for(const {row,caseId,baseline} of cases){
   await verifyCoreDiagnosisSource(run.id);
   const result=await generateExperimentTraces({user:context.actor.username,experimentId,...target,timeoutSeconds:target.timeoutSeconds!,cases:[{caseId,input:row.input}],skillExecution:{version:1,skill:{name:record.skillName,version:record.baseVersion+1,files}},signal:new AbortController().signal},{forceNewTrace:true});
   if(!result.readyCaseIds.includes(caseId))throw new Error('客户端执行失败或缺少本次执行 Trace');
   const scores=await evaluateEvalExperimentCase(experimentId,caseId,context.actor.username,{settleExperiment:false});
   for(const [index,id]of evaluatorIds.entries()){const metric=scores.find(item=>item.evaluatorId===id);if(metric?.status!=='done'||metric.score==null)throw new Error('候选评分不完整');passed&&=metric.score>=baseline[index]&&metric.verdict!=='fail';baseSum+=baseline[index];candidateSum+=metric.score;measured++;}
  }
  await verifyCoreDiagnosisSource(run.id);
  const current=(await context.rpc('read',{experiment_id:source.id}) as {experiment:Source}).experiment;if(fingerprint(current)!==sourceFingerprint)throw new Error('复测期间来源证据发生变化，请重新核验');
  const latest=(await getDataset()).dataset;if(cases.some(({datasetCase})=>{const row=latest.cases.find(item=>item.id===datasetCase.id);return !row||datasetCaseContentHash(row)!==datasetCaseContentHash(datasetCase);}))throw new Error('复测期间来源数据集发生变化，请重新核验');
  await context.rpc('reconcile',{experiment_id:experimentId});
  const outcome={type:'retest-result',experimentId,sourceScore:baseSum/measured,candidateScore:candidateSum/measured,passed};const previous=parseStored<Array<{type?:string}>>(record.sourceRefsJson,[]).filter(item=>item.type!=='retest-result');
  const complete=await prismaRaw.skillOptimizationRecord.updateMany({where:{id:record.id,status:'retesting',retestExperimentId:experimentId,candidateContentHash:record.candidateContentHash},data:{sourceRefsJson:JSON.stringify([...previous,outcome]),status:passed?'retest_passed':'retest_failed',errorMessage:passed?null:'存在回归或失败评测项'}});if(!complete.count)throw new Error('候选或复测状态已变化，不能采用本轮结果');
  await verifyCoreDiagnosisSource(run.id);return {...outcome,reused:false};
 }catch(error){
  let cleanupError:unknown;
  try{if(experimentId)await context.rpc('cancel',{experiment_id:experimentId,operation_key:context.operationKey+':diagnosis-retest-cancel'});}catch(cause){cleanupError=cause;}
  await prismaRaw.skillOptimizationRecord.updateMany({where:{id:record.id,candidateContentHash:record.candidateContentHash,...(experimentId?{retestExperimentId:experimentId}:{})},data:{status:'retest_failed',errorMessage:error instanceof Error?error.message:'复测失败'}});
  if(cleanupError)throw cleanupError;throw error;
 }
}
