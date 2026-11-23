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

import { evaluatorSkillApi, evaluatorSkillUser, skillSourceOwner } from '@/lib/evaluators/evaluator-skill-api';
import { findEvaluatorSkillSource, readLibrarySkill } from '@/lib/evaluators/evaluator-skill-service';
import { previewSkillFiles } from '@/lib/evaluators/evaluator-skill-store';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  return evaluatorSkillApi(async () => {
    const user = await evaluatorSkillUser(request);
    const { name } = await params;
    const owner = skillSourceOwner(request);
    const skill = await findEvaluatorSkillSource(user, name, owner);
    const version = new URL(request.url).searchParams.get('version');
    return {
      name, sourceOwner: owner,
      versions: skill.versions?.map((v: { version: number }) => ({ version: v.version })).sort((a: { version: number }, b: { version: number }) => b.version - a.version) || [],
      ...(version !== null ? previewSkillFiles(await readLibrarySkill(user, name, owner, Number(version))) : {}),
    };
  });
}
