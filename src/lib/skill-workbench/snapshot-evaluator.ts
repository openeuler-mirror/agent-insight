import { getActiveConfig } from '@/lib/storage/server-config';
import { prismaRaw } from '@/lib/storage/prisma';
import { lintSecurity, lintSkillContent } from '@/lib/engine/skill-issues/static-evaluator/linter';
import { runLlmStaticEvaluation } from '@/lib/engine/skill-issues/static-evaluator/llm-evaluator';
import {
  mergeL1FloorWithL2Scores,
  STATIC_EVAL_GENERATOR_L1_L2,
} from '@/lib/engine/skill-issues/static-evaluator';
import { computeSkillSnapshotHash } from './domain';

function bundleFromSnapshot(files: Record<string, string>) {
  const blocks = Object.entries(files)
    .filter(([filePath]) => /^(references|scripts)\//.test(filePath.replaceAll('\\', '/')))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, content]) => `--- 文件: ${filePath.replaceAll('\\', '/')} ---\n${content}\n\n`);
  const full = blocks.join('');
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length > 80_000) {
      chunks.push(current);
      current = '';
    }
    if (block.length <= 80_000) current += block;
    else {
      if (current) { chunks.push(current); current = ''; }
      for (let offset = 0; offset < block.length; offset += 80_000) chunks.push(block.slice(offset, offset + 80_000));
    }
  }
  if (current) chunks.push(current);
  return { full, chunks };
}

export async function getLatestSnapshotEvaluation(input: {
  user: string;
  sessionId: string;
  skillName: string;
  proposedVersion: number;
  contentHash?: string;
}) {
  const { contentHash, ...scope } = input;
  const evaluation = await prismaRaw.skillSnapshotEvaluation.findFirst({
    where: { ...scope, ...(contentHash ? { contentHash } : {}) },
    orderBy: { createdAt: 'desc' },
  });
  if (!evaluation) return null;
  return {
    ...evaluation,
    scores: evaluation.scoresJson ? JSON.parse(evaluation.scoresJson) : {},
    issues: JSON.parse(evaluation.issuesJson || '[]'),
  };
}

export async function runSnapshotStaticEvaluation(input: {
  user: string;
  sessionId: string;
  skillName: string;
  proposedVersion: number;
  files: Record<string, string>;
  trigger: 'manual' | 'generation' | 'optimization';
}) {
  const startedAt = Date.now();
  const contentHash = computeSkillSnapshotHash(input.files);
  const evaluation = await prismaRaw.skillSnapshotEvaluation.create({
    data: {
      sessionId: input.sessionId,
      user: input.user,
      skillName: input.skillName,
      proposedVersion: input.proposedVersion,
      contentHash,
      generator: STATIC_EVAL_GENERATOR_L1_L2,
      trigger: input.trigger,
      status: 'pending',
    },
  });

  const content = input.files['SKILL.md'] || '';
  if (!content) {
    return prismaRaw.skillSnapshotEvaluation.update({
      where: { id: evaluation.id },
      data: { status: 'failed', errorMessage: '工作快照缺少 SKILL.md', durationMs: Date.now() - startedAt },
    });
  }
  const config = await getActiveConfig(input.user);
  if (!config) {
    return prismaRaw.skillSnapshotEvaluation.update({
      where: { id: evaluation.id },
      data: { status: 'failed', errorMessage: '未配置评估模型', durationMs: Date.now() - startedAt },
    });
  }

  try {
    const bundle = bundleFromSnapshot(input.files);
    const diagnoses = [
      ...lintSkillContent(content),
      ...lintSecurity(content, bundle.full),
    ];
    const issues: Array<Record<string, unknown>> = diagnoses.map((item) => ({ ...item, source: 'linter' }));
    const llm = await runLlmStaticEvaluation({
      user: input.user,
      skillContent: content,
      bundleChunks: bundle.chunks,
    });
    if (llm.ok) issues.push(...llm.issues.map((item) => ({ ...item, source: 'llm' })));
    const scores = llm.ok ? {
      scores: mergeL1FloorWithL2Scores(diagnoses, llm.dimensionScores),
      comments: llm.overallComments,
    } : {};
    return prismaRaw.skillSnapshotEvaluation.update({
      where: { id: evaluation.id },
      data: {
        status: llm.ok && !llm.errorMessage ? 'ok' : 'partial',
        scoresJson: Object.keys(scores).length ? JSON.stringify(scores) : null,
        issuesJson: JSON.stringify(issues),
        errorMessage: llm.errorMessage || null,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    return prismaRaw.skillSnapshotEvaluation.update({
      where: { id: evaluation.id },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
