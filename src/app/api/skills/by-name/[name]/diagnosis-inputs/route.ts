import {withCoreControlRoute} from '@/lib/storage-core/control-route';
import { diagnosisRequestResponse, diagnosisUser } from '@/lib/diagnosis/http';
import { DiagnosisError, optimizationInputRequest } from '@/lib/diagnosis/contracts';
import { importDiagnosis, skillSnapshot } from '@/lib/diagnosis/service';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ name: string }> }) {
  return withCoreControlRoute(request,async()=>{
  return diagnosisRequestResponse(request, async () => importDiagnosis(await diagnosisUser(request), (await context.params).name, optimizationInputRequest.parse(await request.json())));

  },["write"]);
}
export async function GET(request: Request, context: { params: Promise<{ name: string }> }) {
  return withCoreControlRoute(request,async()=>{
  return diagnosisRequestResponse(request, async () => {
    const user = await diagnosisUser(request);
    const value = new URL(request.url).searchParams.get('version');
    const version = Number(value);
    if (!value || !Number.isInteger(version) || version < 0) throw new DiagnosisError('请指定基线版本', 400);
    const base = await skillSnapshot(user, (await context.params).name, version);
    return { version, contentHash: base.contentHash, files: base.files };
  });

  },["read"]);
}
