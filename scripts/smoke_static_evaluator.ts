/**
 * 一次性 smoke 脚本：跑 L1 静态评估器，确认 Evaluation + SkillIssue 落库。
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
    enableL2: false,
  });
  console.log('[smoke] orchestrator result:', JSON.stringify(result, null, 2));

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
