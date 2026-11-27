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

/**
 * 一次性 smoke 脚本：跑完整 L1+L2 静态评估器，确认 Evaluation + SkillIssue 落库。
 * （未配置评估模型时直接 skip、不创建评估行——不允许单独跑 L1。）
 * 用法：
 *   npx tsx scripts/smoke_static_evaluator.ts <skillId> <version>
 */

import { runStaticEvaluation } from '../src/lib/engine/skill-issues/static-evaluator';
import { prismaRaw } from '../src/lib/storage/prisma';

async function main() {
  const [, , skillId, versionStr] = process.argv;
  if (!skillId || !versionStr) {
    console.error('usage: tsx scripts/smoke_static_evaluator.ts <skillId> <version>');
    process.exit(1);
  }
  const version = parseInt(versionStr, 10);

  console.log(`[smoke] running static eval skillId=${skillId} version=${version}`);
  const result = await runStaticEvaluation({
    skillId,
    version,
    user: null,
    trigger: 'manual',
  });
  console.log('[smoke] orchestrator result:', JSON.stringify(result, null, 2));

  if (result.status === 'skipped') {
    console.error(`[smoke] skipped: ${result.skipReason}`);
    process.exit(1);
  }
  if (!result.evaluationId) {
    console.error('[smoke] no evaluationId returned');
    process.exit(1);
  }

  const evaluation = await prismaRaw.evaluation.findUnique({
    where: { id: result.evaluationId },
    include: { issues: true },
  });
  console.log('[smoke] evaluation row:', {
    id: evaluation?.id,
    type: evaluation?.type,
    status: evaluation?.status,
    generator: evaluation?.generator,
    contentHash: evaluation?.contentHash,
    durationMs: evaluation?.durationMs,
    issueCount: evaluation?.issues.length ?? 0,
  });
  for (const i of evaluation?.issues ?? []) {
    console.log(`  - [${i.severity}] (${i.dimension}) ${i.summary}`);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('[smoke] fatal:', e);
  process.exit(1);
});
