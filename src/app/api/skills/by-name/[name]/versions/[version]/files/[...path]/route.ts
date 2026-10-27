import { evaluatorSkillApi, evaluatorSkillUser, skillSourceOwner } from '@/lib/evaluators/evaluator-skill-api';
import { readLibrarySkill } from '@/lib/evaluators/evaluator-skill-service';
import { previewSkillFiles } from '@/lib/evaluators/evaluator-skill-store';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ name: string; version: string; path: string[] }> }) {
  return evaluatorSkillApi(async () => {
    const { name, version, path } = await params;
    const files = await readLibrarySkill(await evaluatorSkillUser(request), name, skillSourceOwner(request), Number(version));
    return previewSkillFiles(files, path.join('/'));
  });
}
