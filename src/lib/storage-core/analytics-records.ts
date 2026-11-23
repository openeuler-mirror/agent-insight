import type { AnalyticsSource } from './analytics';
import { calculateCost, getModelPricing } from '../shared/model-config';

function array(value:string|null):unknown[]|undefined {
  if(!value)return undefined;
  const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:undefined;
}
export function analyticsRecords(source:Pick<AnalyticsSource,'findMany'>,filters:{agentName?:string;skill?:string;taskId?:string;framework?:string}={}) {
  const candidates=source.findMany({where:{...filters,...(filters.taskId?{}:{isSubagent:false})},orderBy:{timestamp:'desc'}});
  const canonical=new Map<string,typeof candidates[number]>();
  for(const row of candidates) {
    const key=row.taskId||row.id;const previous=canonical.get(key);
    if(!previous||row.id===row.taskId&&previous.id!==previous.taskId||row.id!==row.taskId&&previous.id!==previous.taskId&&(row.timestamp.getTime()>previous.timestamp.getTime()||row.timestamp.getTime()===previous.timestamp.getTime()&&row.id<previous.id))canonical.set(key,row);
  }
  return [...canonical.values()].map(row=>{
    const model=row.model||undefined;const pricing=model?getModelPricing(model)?.pricing:null;
    return {...row,upload_id:row.id,task_id:row.taskId||undefined,query:row.query||undefined,framework:row.framework||undefined,model,agent:row.agentName||undefined,agentName:row.agentName||undefined,timestamp:row.timestamp.toISOString(),tokens:row.tokens||undefined,latency:row.latency||undefined,cost:pricing&&row.inputTokens!=null&&row.outputTokens!=null?calculateCost(row.inputTokens,row.outputTokens,pricing,row.cacheReadInputTokens??undefined,row.cacheCreationInputTokens??undefined):undefined,failures:array(row.failures),tool_call_count:row.toolCallCount??undefined,llm_call_count:row.llmCallCount??undefined,tool_call_error_count:row.toolCallErrorCount??undefined,input_tokens:row.inputTokens??undefined,output_tokens:row.outputTokens??undefined};
  });
}
