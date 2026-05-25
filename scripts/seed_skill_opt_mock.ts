/**
 * Seed Skill / SkillVersion / Evaluation / SkillIssue 表，用 skill-opt 前端 _mock.ts
 * 里的 MOCK_SKILLS + MOCK_ISSUES 数据。
 *
 * **目的**：新 dev clone 仓库 + `npm install` 后，跑一次这个脚本就能在 /skill-opt
 *   页面看到真实的 skill 列表 + 优化点列表，不用先去 trace 数据 / 跑评估器。
 *
 * **幂等**：每次执行先按 generator 标识清理 Evaluation + SkillIssue（cascade 删 issue），
 *   Skill / SkillVersion 用 upsert（按 (name, user) / (skillId, version) unique 约束）。
 *   重跑安全。
 *
 * **数据归属**：所有行的 user = 'skill-insight@huawei.com'（项目默认登录账号）；
 *   所有 issue 的 source 暂时统一标记为 'static'（真实 trace/fault/log 来源等评估器
 *   接入后再改）。
 *
 * **跑法**：
 *   npm run seed:skill-opt
 *   # 或者
 *   node --import tsx scripts/seed_skill_opt_mock.ts
 *
 * **前置**：本脚本不自动跑 prisma db push。如果是干净 clone 还没建表，先跑：
 *   npx prisma db push
 *   （`npm install` 的 postinstall 已经会自动 push，正常情况下可跳过）
 */
import { config } from 'dotenv';
config();

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const USER = 'skill-insight@huawei.com';        // 与 trajectory eval seed 同 user
const GENERATOR = 'mock-seed@2026-05-08';        // 清理标记

// ──────────────── inline copy of _mock.ts data ────────────────
// 不直接 import _mock.ts —— 它在 src/app/(main)/skill-opt/ 下路径含括号，
// 且 _mock.ts 内 generateNextDraft 等函数对 seed 无用。直接内联数据更稳。

interface MockSkillVersion {
  version: number;
  createdAt: string;
  changeLog?: string;
}
interface MockSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  tags: string[];
  activeVersion: number;
  updatedAt: string;
  versions: MockSkillVersion[];
}

const MOCK_SKILLS: MockSkill[] = [
  {
    id: 'sk_1',
    name: 'pdf-extractor',
    description: '从 PDF 中抽取结构化文本与表格，支持多页与扫描件 OCR。',
    category: '文档处理',
    author: 'pumpkin',
    tags: ['pdf', 'ocr', 'extract'],
    activeVersion: 1,
    updatedAt: '2026-04-28T10:00:00Z',
    versions: [
      { version: 1, createdAt: '2026-04-28T10:00:00Z', changeLog: '修复多页索引越界' },
      { version: 0, createdAt: '2026-03-12T08:00:00Z', changeLog: '初始版本' },
    ],
  },
  {
    id: 'sk_2',
    name: 'doc-summarizer',
    description: '长文档分段摘要，输出 bullet points + 关键引用。',
    category: '文档处理',
    author: 'team',
    tags: ['summary', 'long-context'],
    activeVersion: 3,
    updatedAt: '2026-05-01T14:00:00Z',
    versions: [
      { version: 3, createdAt: '2026-05-01T14:00:00Z', changeLog: '加入引用片段' },
      { version: 2, createdAt: '2026-04-15T11:00:00Z' },
      { version: 1, createdAt: '2026-04-01T09:00:00Z' },
      { version: 0, createdAt: '2026-03-20T15:00:00Z', changeLog: '初始版本' },
    ],
  },
  {
    id: 'sk_3',
    name: 'chart-gen',
    description: '从 CSV/JSON 生成图表（matplotlib），支持柱/折/散点/热力。',
    category: '数据可视化',
    author: 'team',
    tags: ['chart', 'matplotlib'],
    activeVersion: 2,
    updatedAt: '2026-04-30T09:30:00Z',
    versions: [
      { version: 2, createdAt: '2026-04-30T09:30:00Z' },
      { version: 1, createdAt: '2026-04-10T12:00:00Z' },
      { version: 0, createdAt: '2026-03-25T10:00:00Z', changeLog: '初始版本' },
    ],
  },
];

interface MockIssue {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category: string;
  summary: string;
  evidence?: string;
  // mock 里 source.kind 有 4 种 (trace/fault/log/static)；按用户要求一律存 'static'
}

const MOCK_ISSUES: Record<string, MockIssue[]> = {
  'pdf-extractor': [
    { id: 'i1', severity: 'medium', category: 'description', summary: '描述冗长，超 200 字', evidence: 'SKILL.md 第 1-5 行可压到 80 字内' },
    { id: 'i2', severity: 'high', category: 'examples', summary: '缺少多页 PDF 示例', evidence: '历史 trace 中 30% 调用是 multi-page，但 examples/ 只覆盖单页' },
    { id: 'i3', severity: 'high', category: 'scripts', summary: 'extract.py 在 R1 模型下报 token 超限', evidence: 'fault: 2026-04 共 12 次报错' },
    { id: 'i4', severity: 'low', category: 'metadata', summary: 'tags 为空' },
  ],
  'doc-summarizer': [
    { id: 'i5', severity: 'medium', category: 'description', summary: '描述与实际能力不符' },
  ],
  'chart-gen': [],
};

function getSkillContent(name: string, version: number, skill: MockSkill): string {
  return `---
name: ${name}
version: ${version}
description: ${skill.description}
tags: [${skill.tags.join(', ')}]
---

# ${name}

${skill.description}

## When to use

(mock 内容) 在以下场景调用本 skill：
- 场景 A
- 场景 B
- 场景 C

## How to use

\`\`\`bash
python scripts/main.py --input <file> --output <dir>
\`\`\`

## Examples

见 \`examples/\` 目录。
`;
}

// ──────────────── seed pipeline ────────────────

async function main() {
  console.log('=== Seeding skill-opt mock data ===');

  // 1. 清理旧 seed 数据（按 generator 标记）
  const oldEvals = await prisma.evaluation.findMany({
    where: { generator: GENERATOR },
    select: { id: true },
  });
  if (oldEvals.length > 0) {
    console.log(`Cleaning ${oldEvals.length} old evaluation rows + their issues (cascade)...`);
    await prisma.evaluation.deleteMany({ where: { generator: GENERATOR } });
  }

  // 2. upsert Skill + SkillVersion
  for (const ms of MOCK_SKILLS) {
    const skill = await prisma.skill.upsert({
      where: { name_user: { name: ms.name, user: USER } },
      create: {
        name: ms.name,
        category: ms.category,
        description: ms.description,
        tags: JSON.stringify(ms.tags),
        author: ms.author,
        user: USER,
        activeVersion: ms.activeVersion,
        visibility: 'private',
        isUploaded: false,
      },
      update: {
        category: ms.category,
        description: ms.description,
        tags: JSON.stringify(ms.tags),
        activeVersion: ms.activeVersion,
      },
    });
    console.log(`  Skill: ${ms.name} (id=${skill.id})`);

    for (const v of ms.versions) {
      await prisma.skillVersion.upsert({
        where: { skillId_version: { skillId: skill.id, version: v.version } },
        create: {
          skillId: skill.id,
          version: v.version,
          content: getSkillContent(ms.name, v.version, ms),
          changeLog: v.changeLog,
          createdAt: new Date(v.createdAt),
        },
        update: {
          content: getSkillContent(ms.name, v.version, ms),
          changeLog: v.changeLog,
        },
      });
    }
    console.log(`    versions: [${ms.versions.map(v => `v${v.version}`).join(', ')}]`);

    // 3. 给 activeVersion 创建一条 Evaluation + 该版本下所有 mock issues 作为 SkillIssue
    const issues = MOCK_ISSUES[ms.name] || [];
    if (issues.length === 0) {
      console.log(`    no mock issues for ${ms.name}, skip evaluation`);
      continue;
    }
    const skillContent = getSkillContent(ms.name, ms.activeVersion, ms);
    const contentHash = simpleSha(skillContent);

    const evaluation = await prisma.evaluation.create({
      data: {
        type: 'static',
        skillId: skill.id,
        version: ms.activeVersion,
        user: USER,
        contentHash,
        status: 'ok',
        durationMs: 0,
        generator: GENERATOR,
      },
    });
    console.log(`    eval (static): ${evaluation.id} for v${ms.activeVersion}`);

    for (const it of issues) {
      const created = await prisma.skillIssue.create({
        data: {
          evaluationId: evaluation.id,
          source: 'static',                         // 全部统一标 static（per 用户要求）
          skillId: skill.id,
          version: ms.activeVersion,
          user: USER,
          dedupKey: `${ms.name}_${it.id}`,           // 简单稳定的 dedup key
          severity: it.severity,                     // 已经是 high/medium/low
          summary: it.summary,
          evidence: it.evidence,
          ruleId: it.category,                       // 把 mock category 当 ruleId 占位
          dimension: null,
        },
      });
      console.log(`      issue: [${it.severity}] ${it.summary.slice(0, 30)}... (id=${created.id.slice(0, 8)})`);
    }
  }

  console.log('=== Done ===');
  console.log('');
  console.log('✓ Seeded data is owned by user `' + USER + '`');
  console.log('  → Visit /skill-opt to verify (must be logged in as that user, or run dev with that login)');
  console.log('  → Re-run this script anytime; it cleans old seed and re-inserts (idempotent).');
  console.log('');
  console.log('Quick DB check:');
  console.log("  sqlite3 data/witty_insight.db \"SELECT s.name, COUNT(si.id) FROM Skill s LEFT JOIN SkillIssue si ON s.id = si.skillId GROUP BY s.id;\"");
}

// 简化版 hash（避免引入 crypto 之类的；seed 用稳定占位即可）
function simpleSha(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `mock-${(h >>> 0).toString(16)}`;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
