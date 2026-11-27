import { z } from 'zod';
import { diagnosisResponse, diagnosisUser } from '@/lib/diagnosis/http';
import { freezeTraceReport } from '@/lib/diagnosis/service';

export async function POST(request: Request) {
  return diagnosisResponse(async () => {
    const user = await diagnosisUser(request);
    const { executionId, generatedAt } = z.object({ executionId: z.string().min(1), generatedAt: z.string().min(1) }).parse(await request.json());
    return freezeTraceReport(user, executionId, generatedAt);
  });
}
