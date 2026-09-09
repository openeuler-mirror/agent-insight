export function jsonModelOptions(config:{baseUrl?:string;model:string}){
 const officialDeepSeek=config.baseUrl&&new URL(config.baseUrl).hostname==='api.deepseek.com';
 return officialDeepSeek&&/^deepseek-v4-/.test(config.model)
  ? {thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8192}
  : {};
}
