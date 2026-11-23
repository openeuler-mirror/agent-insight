/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
