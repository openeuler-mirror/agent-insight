import { diagnosisResponse, diagnosisUser } from '@/lib/diagnosis/http';
import { DiagnosisError, diagnosisRequest } from '@/lib/diagnosis/contracts';
import { buildSnapshot, previewSnapshot, submitDiagnosis } from '@/lib/diagnosis/service';
import { prismaRaw } from '@/lib/storage/prisma';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string; caseId: string }> }) {
  return diagnosisResponse(async () => {
    const user = await diagnosisUser(request);
    const { id, caseId } = await context.params;
    const body = diagnosisRequest.parse(await request.json());
    const snapshot = await buildSnapshot(user, id, caseId, body.resultIds);
    if (body.preview) return previewSnapshot(snapshot);
    if (!body.requestKey || !body.expectedInputHash) throw new DiagnosisError('请先预览并确认诊断输入', 400);
    const run = await submitDiagnosis(user, snapshot, { ...body, requestKey: body.requestKey, expectedInputHash: body.expectedInputHash });
    return { runId: run.id, status: run.status };
  });
}
export async function GET(request: Request, context: { params: Promise<{ id: string; caseId: string }> }) {
  return diagnosisResponse(async () => {
    const user = await diagnosisUser(request);
    const { id, caseId } = await context.params;
    return { runs: await prismaRaw.diagnosisRun.findMany({ where: { user, experimentId: id, caseId }, select: { id: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 10 }) };
  });
}
