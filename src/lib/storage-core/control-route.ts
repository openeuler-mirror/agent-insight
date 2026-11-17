import {isStorageCoreEnabled} from './mode';
import {withCoreControlRequest,requireCoreControlContext} from './control-context';
import {withCoreControlDevice} from './control-auth';
import {requireCoreControlCapabilities} from './control-repository';
export async function withCoreControlRoute<T extends Response>(request:Request,action:()=>Promise<T>,capabilities:string[]=[]):Promise<T|Response>{
 if(!isStorageCoreEnabled())return action();
 try{
  if(/^Bearer dc_/.test(request.headers.get('authorization')||'')){if(capabilities.some(value=>['execute','publish','delete'].includes(value)))throw Object.assign(new Error('Device control cannot become an execution actor'),{status:403});return await withCoreControlDevice(request,action);}
  let identity=request;const queryKey=new URL(request.url).searchParams.get('apiKey');if(!request.headers.has('x-witty-api-key')&&!request.headers.has('authorization')&&queryKey){const headers=new Headers(request.headers);headers.set('x-witty-api-key',queryKey);identity=new Request(request.url,{method:'GET',headers});}
  return await withCoreControlRequest(identity,async()=>{if(capabilities.length)await requireCoreControlCapabilities(...capabilities);requireCoreControlContext().capabilities=capabilities;if(capabilities.includes('write')&&request.headers.get('content-type')?.includes('application/json')){const body=await request.clone().json().catch(()=>null);if(body&&typeof body==='object'&&!Array.isArray(body)&&typeof body.user==='string'&&body.user!==requireCoreControlContext().actor.username)throw Object.assign(new Error('Control owner differs'),{status:403});}return action();});
 }catch(error){const status=typeof (error as any)?.status==='number'?(error as any).status:502;return Response.json({error:status===401?'Authentication required':status===403?'Forbidden':status===409?'Data changed; reload and retry':'Storage request failed'},{status,headers:{'cache-control':'no-store'}});}
}
export async function withCoreControlInternalRoute<T extends Response>(request:Request,action:()=>Promise<T>):Promise<T|Response>{
 if(!isStorageCoreEnabled())return action();
 try{
  const {assertInternalCaller}=await import('@/lib/reliability/internal-guard');assertInternalCaller(request);
  const body=await request.clone().json();if(new URL(request.url).pathname.endsWith('/control-presence')&&body.connected!==true)return action();
  const device=new Request('http://localhost/internal/control-device',{headers:{authorization:String(body.authorization||''),'x-agent-insight-client-id':String(body.clientId||'')}});
  return await withCoreControlDevice(device,action);
 }catch(error){return Response.json({error:'Verified internal device required'},{status:typeof (error as any)?.status==='number'?(error as any).status:403});}
}
