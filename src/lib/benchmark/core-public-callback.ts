import {readCoreBytes} from '@/lib/storage-core/server';
import {BenchmarkProtocolError} from '../../../packages/benchmark-protocol/src/errors';
import {benchmarkCallbackRpc,type BenchmarkCallbackContext} from './core-store';

export function coreBenchmarkCallbackContext(request:Request,verifiedDeviceClientId?:string,verifiedDeviceOwner?:string):BenchmarkCallbackContext{
 const capability=request.headers.get('x-agent-insight-callback-token')||'';
 if(!/^bcap_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(capability)||capability.length>4096)throw new BenchmarkProtocolError('CALLBACK_UNAUTHORIZED','缺少有效Benchmark回调凭据',401);
 return {capability,...(verifiedDeviceClientId?{verifiedDeviceClientId}:{}),...(verifiedDeviceOwner?{verifiedDeviceOwner}:{})};
}
export async function coreBenchmarkCallbackJson<T extends object=Record<string,unknown>>(request:Request):Promise<T>{
 const bytes=await readCoreBytes(request.body,128*1024*1024);
 try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();return body as T;}catch{throw new BenchmarkProtocolError('CALLBACK_JSON_INVALID','Benchmark回调不是合法JSON对象',400);}
}
export async function coreBenchmarkCallbackArtifact(request:Request,context:BenchmarkCallbackContext,evaluationId?:string):Promise<unknown>{
 const bytes=await readCoreBytes(request.body,65*1024*1024);let form:FormData;
 try{form=await new Request(request.url,{method:'POST',headers:request.headers,body:Buffer.from(bytes)}).formData();}catch{throw new BenchmarkProtocolError('ARTIFACT_MULTIPART_INVALID','Artifact请求不是合法multipart',400);}
 const raw=form.get('metadata');let metadata:Record<string,unknown>;
 try{if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>16384)throw Error();metadata=JSON.parse(raw);if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error();}catch{throw new BenchmarkProtocolError('ARTIFACT_METADATA_INVALID','Artifact metadata不是合法JSON对象',400);}
 if(evaluationId&&metadata.evaluationId!=null&&metadata.evaluationId!==evaluationId)throw new BenchmarkProtocolError('EVALUATION_ID_MISMATCH','证据evaluationId与回调路径不一致',422);
 const file=form.get('file');if(!(file instanceof File))throw new BenchmarkProtocolError('ARTIFACT_FILE_MISSING','Artifact缺少file字段',400);
 if(file.size>64*1024*1024)throw new BenchmarkProtocolError('ARTIFACT_TOO_LARGE','Artifact超过64MiB预算',413);
 return benchmarkCallbackRpc(context,'artifact_put',{job_id:evaluationId||String(metadata.runId||''),name:String(metadata.name||file.name||''),kind:String(metadata.kind||''),media_type:String(metadata.mediaType||file.type||''),expected_sha256:String(metadata.sha256||''),bytes_base64:Buffer.from(await file.arrayBuffer()).toString('base64')});
}
export function coreBenchmarkArtifactResponse(artifact:{name:string;mediaType:string;sha256:string;bytes:Uint8Array}):Response{
 const fallback=artifact.name.split('/').at(-1)!.replace(/[^A-Za-z0-9._-]/g,'_')||'artifact';const encoded=encodeURIComponent(artifact.name.split('/').at(-1)!).replace(/[!'()*]/g,value=>'%'+value.charCodeAt(0).toString(16).toUpperCase());
 return new Response(new Blob([new Uint8Array(artifact.bytes)]),{headers:{'content-type':artifact.mediaType,'content-length':String(artifact.bytes.byteLength),'content-disposition':`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,etag:`"${artifact.sha256}"`,'cache-control':'private, no-store'}});
}
