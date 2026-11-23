import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { withCoreExperiments, requireCoreExperimentContext, coreExperimentFailure } from '@/lib/storage-core/experiments';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { resolveUser } from '@/lib/auth/auth';
import { DiagnosisError } from './contracts';
import { prismaRaw } from '@/lib/storage/prisma';

export async function canAccessDiagnosisSession(request: Request, id: string) {
  if (!id.startsWith('diagnosis-')) return true;
  const { username } = await resolveUser(request);
  return Boolean(username && await prismaRaw.skillOptSession.findFirst({ where: { id, user: username }, select: { id: true } }));
}

export async function diagnosisRequestResponse(request: Request, operation: () => Promise<unknown>, status = 200) {

  try { return await withCoreExperiments(request, () => diagnosisResponse(operation, status)); } catch (error) { return coreExperimentFailure(error); }
}

export async function diagnosisUser(request: Request) {
  return requireCoreExperimentContext().actor.username;
}
export async function diagnosisResponse(operation: () => Promise<unknown>, status = 200) {
  try { return NextResponse.json(await operation(), { status }); }
  catch (error) {
    if (error instanceof DiagnosisError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ error: '请求参数不合法' }, { status: 400 });
    return coreExperimentFailure(error);
  }
}
