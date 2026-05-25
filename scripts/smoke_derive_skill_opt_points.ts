/**
 * 一次性 smoke：跑 deriveAndPersistOptPoints，验证写入 Evaluation + SkillIssue 行。
 * 用法：tsx scripts/smoke_derive_skill_opt_points.ts <skillName> <version>
 */

import { deriveAndPersistOptPoints } from '../src/lib/engine/evaluation/derive-skill-opt-points';
import { prismaRaw } from '../src/lib/storage/prisma';

async function main() {
  const [, , skillName, versionStr] = process.argv;
  if (!skillName || !versionStr) {
    console.error('usage: tsx scripts/smoke_derive_skill_opt_points.ts <skillName> <version>');
    process.exit(1);
  }

  const skillRow = await prismaRaw.skill.findFirst({ where: { name: skillName }, select: { user: true } });
  const user = skillRow?.user ?? 'smoke';
  const version = parseInt(versionStr, 10);
  const runId = `smoke-run-${Date.now()}`;

  const fakeTrajectory = {
    id: 'fake-traj-row',
    deviationStepsJson: JSON.stringify([
      { stepIndex: 3, name: 'parse_pdf', deviation: '没遵循 SKILL.md 第 2 步的并行限制', severity: 'high', is_skill_attributable: true, improvement_suggestion: '在 SKILL.md "并行限制" 段加一句：单实例最多 2 个 PDF 解析任务并发' },
      { stepIndex: 5, name: 'extract_tables', deviation: '没调用 reference 文件中的 normalize_columns', severity: 'medium', is_skill_attributable: true },
    ]),
    rootCauseStep: '#3 parse_pdf',
    reasonText: 'fake',
    rawAnalysisJson: JSON.stringify({
      key_point_findings: [
        { content: '应该首先校验输入 PDF 是否扫描件', covered: false, severity: 'medium', explanation: 'agent 直接走文本提取', is_skill_attributable: true },
      ],
      raw_subagent_outputs: {
        tool_choice: {
          issues: [
            { step_index: 7, tool: 'plain_text_extract', issue: '应该用 ocr_extract', reason: 'PDF 第 3 页是扫描页', severity: 'medium', is_skill_attributable: true, improvement_suggestion: '在 SKILL.md 工具选择决策树加分支：PDF 含扫描页 → ocr_extract' },
          ],
        },
      },
    }),
  };

  console.log(`[smoke] running deriveAndPersistOptPoints user=${user} skill=${skillName} v${version} runId=${runId}`);
  const written = await deriveAndPersistOptPoints({
    user: user || 'smoke',
    taskId: 'fake-task-id-123',
    runId,
    trajectoryRow: fakeTrajectory as any,
    skills: [{ name: skillName, version }],
  });

  console.log(`[smoke] wrote ${written} SkillIssue rows`);

  const evaluations = await prismaRaw.evaluation.findMany({
    where: { runId },
    include: { issues: { select: { id: true, severity: true, category: true, summary: true, suggestedFix: true } } },
  });
  for (const ev of evaluations) {
    console.log(`[smoke] Evaluation ${ev.id} type=${ev.type} skillId=${ev.skillId} executionId=${ev.executionId} issues=${ev.issues.length}`);
    for (const i of ev.issues) {
      console.log(`  - [${i.severity}] (${i.category}) ${i.summary}${i.suggestedFix ? ' → ' + i.suggestedFix : ''}`);
    }
  }
  process.exit(0);
}

main().catch(e => { console.error('[smoke] fatal:', e); process.exit(1); });
