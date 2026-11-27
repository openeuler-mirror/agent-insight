import { diagnosisResponse, diagnosisUser } from '@/lib/diagnosis/http';
import { getDiagnosis } from '@/lib/diagnosis/service';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  return diagnosisResponse(async () => getDiagnosis(await diagnosisUser(request), (await context.params).runId));
}
