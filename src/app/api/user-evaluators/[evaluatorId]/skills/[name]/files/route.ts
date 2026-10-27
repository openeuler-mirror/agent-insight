import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { savedSkillBindings } from '@/lib/evaluators/evaluator-skill-service';
import { evaluatorSkillApi, evaluatorSkillUser } from '@/lib/evaluators/evaluator-skill-api';
import { EvaluatorSkillError, EvaluatorSkillStore } from '@/lib/evaluators/evaluator-skill-store';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ evaluatorId: string; name: string }> }) {
  return evaluatorSkillApi(async () => {
    const user = await evaluatorSkillUser(request);
    const { evaluatorId, name } = await params;
    const card = (await readUserCustomEvaluators(user) as EvaluatorCard[]).find(c => c.id === evaluatorId);
    const binding = savedSkillBindings(card?.llmConfig?.skills).find(s => s.name === name);
    if (!binding) throw new EvaluatorSkillError('Skill 绑定不存在', 404);
    return new EvaluatorSkillStore().preview(user, binding.snapshotHash, new URL(request.url).searchParams.get('path'));
  });
}
