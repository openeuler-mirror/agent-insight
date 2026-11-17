import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {processProxyEnd} from '@/lib/ingest/proxy-end';
import {handleCoreProxyEnd} from '@/lib/storage-core/collector-proxy';
export const maxDuration=60;
export async function POST(request:Request,{params}:{params:Promise<{taskId:string}>}){const {taskId}=await params;return isStorageCoreEnabled()?handleCoreProxyEnd(request,taskId):processProxyEnd(request,taskId);}
