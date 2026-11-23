import {getModelFetch} from './model-fetch';
export function configuredModelFetch(config:{apiKey?:string;headers?:Record<string,string>},transport:typeof fetch=getModelFetch()):typeof fetch{
 return async(input,init)=>{
  if(!config.apiKey?.trim()&&!new Headers(config.headers||{}).has('authorization')){
   const headers=new Headers(init?.headers||(input instanceof Request?input.headers:undefined));headers.delete('authorization');
   return transport(input,{...init,headers});
  }
  return transport(input,init);
 };
}
