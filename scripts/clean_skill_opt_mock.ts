/**
 * 清理 seed_skill_opt_mock.ts 注入的所有 mock 数据。
 *
 * 影响范围（限定 user='skill-insight@huawei.com' + 三个固定 mock skill 名）：
 *   - Skill: pdf-extractor / doc-summarizer / chart-gen
 *   - SkillVersion: 上述 skill 的所有版本（cascade）
 *   - Evaluation: 上述 skill 下的全部评估事件（cascade）
 *   - SkillIssue: 评估事件下的全部 issue（cascade）
 *
 * **注意**：删除是按 (name, user) 对应到 Skill 行，再靠 onDelete: Cascade 递归。
 *   如果你在同一 user 下手工创建了同名 skill，本脚本会一并删掉。日常 dev 使用 OK，
 *   生产数据不要用。
 *
 * 跑法：
 *   npm run clean:skill-opt
 *   # 或者
 *   node --import tsx scripts/clean_skill_opt_mock.ts
 */
import { config } from 'dotenv';
config();

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const USER = 'skill-insight@huawei.com';
const MOCK_SKILL_NAMES = ['pdf-extractor', 'doc-summarizer', 'chart-gen'];

async function main() {
  console.log('=== Cleaning skill-opt mock data ===');
  console.log(`  scope: user="${USER}", skills=[${MOCK_SKILL_NAMES.join(', ')}]`);
  console.log('');

  // 先查 before 状态
  const before = await snapshot();
  printSnapshot('Before:', before);

  // 找到目标 Skill 行
  const skills = await prisma.skill.findMany({
    where: { user: USER, name: { in: MOCK_SKILL_NAMES } },
    select: { id: true, name: true },
  });
  if (skills.length === 0) {
    console.log('  → no matching Skill rows found, nothing to do');
    return;
  }

  // 删 Skill —— SkillVersion / Evaluation / SkillIssue 全部 cascade
  const result = await prisma.skill.deleteMany({
    where: { user: USER, name: { in: MOCK_SKILL_NAMES } },
  });
  console.log(`  → deleted ${result.count} Skill row(s) (cascade dropped versions/evaluations/issues)`);

  console.log('');
  const after = await snapshot();
  printSnapshot('After:', after);

  console.log('');
  console.log('=== Done ===');
  console.log('');
  console.log('Re-seed anytime with: npm run seed:skill-opt');
}

async function snapshot() {
  const [skills, versions, evals, issues] = await Promise.all([
    prisma.skill.count({ where: { user: USER, name: { in: MOCK_SKILL_NAMES } } }),
    prisma.skillVersion.count({
      where: { Skill: { user: USER, name: { in: MOCK_SKILL_NAMES } } },
    }),
    prisma.evaluation.count({
      where: { user: USER, Skill: { name: { in: MOCK_SKILL_NAMES } } },
    }),
    prisma.skillIssue.count({
      where: { user: USER, Skill: { name: { in: MOCK_SKILL_NAMES } } },
    }),
  ]);
  return { skills, versions, evals, issues };
}

function printSnapshot(label: string, s: { skills: number; versions: number; evals: number; issues: number }) {
  console.log(`  ${label}`);
  console.log(`    Skill         : ${s.skills}`);
  console.log(`    SkillVersion  : ${s.versions}`);
  console.log(`    Evaluation    : ${s.evals}`);
  console.log(`    SkillIssue    : ${s.issues}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
