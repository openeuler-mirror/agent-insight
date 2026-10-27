import { evaluatorSkillApi, evaluatorSkillUser } from '@/lib/evaluators/evaluator-skill-api';
import { EvaluatorSkillStore } from '@/lib/evaluators/evaluator-skill-store';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ importToken: string }> }) {
  return evaluatorSkillApi(async () => new EvaluatorSkillStore().preview(
    await evaluatorSkillUser(request), (await params).importToken, new URL(request.url).searchParams.get('path'), true,
  ));
}
