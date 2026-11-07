import {loadExecutionConfig} from './config.mjs';
export function contextConfig(ctx={}){return ctx.executionConfig||loadExecutionConfig({profile:process.env.E2E_LANE||'pr'});}
export function executionModel(ctx={}){return 'e2e/'+contextConfig(ctx).model.modelName;}
export function openCodeModelConfig(ctx={}){
 const {model,timeouts}=contextConfig(ctx);return {$schema:'https://opencode.ai/config.json',model:executionModel(ctx),provider:{e2e:{npm:'@ai-sdk/openai-compatible',name:'E2E configured model',options:{baseURL:ctx.modelBaseUrl||model.baseUrl,apiKey:ctx.key,timeout:timeouts.modelRequestMs},models:{[model.modelName]:{name:model.modelName,limit:{context:model.contextTokens,output:model.outputTokens},options:model.options}}}}};
}
export function internalModelConfig(ctx={}){const {model,timeouts}=contextConfig(ctx);return {provider:{'deepseek-official':{options:{timeout:timeouts.modelRequestMs},models:{[model.modelName]:{limit:{context:model.contextTokens,output:model.outputTokens},options:model.options}}}}};}
