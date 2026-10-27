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
