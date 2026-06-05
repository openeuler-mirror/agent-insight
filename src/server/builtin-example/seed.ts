/**
 * 新用户注册时一次性注入的「内置示例数据」。
 *
 * 在 /api/auth/apikey 首次创建 User 后调用 seedBuiltinExampleForUser(user)：
 *   - 1 个内置数据集「messages 日志分析（内置示例）」(ideal_output, 10 cases)
 *   - 3 条内置链路追踪 Trace (Session + Execution)，挂在一个 ownership='user' 的
 *     demo agent (messages-log-analyzer) 名下，使其落到链路追踪页默认的「用户 Agent」
 *     视图里（其他用户/系统/评测器 trace 不受影响——ownership 按 (platform,name) 解析，
 *     而这个 agent 名只被这几条 demo trace 使用）。其中 2 条为正常成功链路，
 *     第 3 条（label 后缀 -err-v0）为同场景下的「带报错」链路：Agent 误用 skill 文档里
 *     硬编码的 /var/log/messages（而非用户给定路径）反复 grep，触发多次工具报错并误判为
 *     「无攻击」，专门用于演示「智能诊断 / 故障诊断」能力。
 *
 * 语义：只在「用户从未被注入过」时执行一次（标记 = demo agent 是否存在）。
 * 用户之后删掉示例数据，不会再补回来——因为本函数只在 createUser 成功（新用户）时被调一次。
 *
 * 数据来源：src/server/builtin-example/fixtures.json，由 messages 日志分析 数据集 +
 * 两条真实 messages 分析 trace 导出，外加 1 条人工构造的「带报错」同场景 trace
 * （见该目录 README 注释）。
 */
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/storage/prisma';
import { createAgentDatasetRecord, type DatasetCase, type DatasetKind } from '@/server/agent_datasets_storage';
import fs from 'node:fs';
import path from 'node:path';
import fixturesRaw from './fixtures.json';
import skillBundleRaw from './skill-bundle.json';

const fixtures = fixturesRaw as {
  dataset: Record<string, unknown> & { casesJson: string };
  traces: Array<{ taskId: string; session: Record<string, unknown> | null; execution: Record<string, unknown> | null }>;
};

/** 内置 demo skill 包：SKILL.md 内容 + references/scripts 资源（path→content）。 */
const skillBundle = skillBundleRaw as {
  name: string;
  category: string;
  description: string;
  tags: string | null;
  visibility: string;
  version: number;
  changeLog: string | null;
  content: string;
  files: string[];
  assets: Record<string, string>;
};

const PLATFORM = 'opencode';
const DEMO_AGENT_NAME = 'messages-log-analyzer';
const DEMO_AGENT_DESC = '内置示例：messages 日志安全分析 Agent（新用户注册时自动注入的演示 trace）';
const BUILTIN_DATASET_NAME = 'messages 日志分析（内置示例）';

/** Execution 上要从 fixture 透传的纯指标字段（数值型，存在才填）。 */
const EXEC_METRIC_FIELDS = [
  'tokens', 'cost', 'latency', 'toolCallCount', 'llmCallCount', 'inputTokens', 'outputTokens',
  'toolCallErrorCount', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'maxSingleCallTokens',
  'reasoningTokens', 'answerScore', 'skillScore', 'skillTriggerRate',
] as const;

/** fixture 里时间戳是 epoch ms（数字）；也兼容 ISO 字符串。 */
function toDate(v: unknown): Date | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return /^\d+$/.test(trimmed) ? new Date(Number(trimmed)) : new Date(trimmed);
  }
  return undefined;
}

function safeTags(tagsJson: unknown): string[] {
  try {
    const arr = JSON.parse(String(tagsJson ?? '[]'));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 注入内置 demo skill：Skill + SkillVersion + data/storage/skills/<id>/v<n>/ 资源。
 * 名字带 -demo 后缀，避免与用户后续用「Skill 生成」自己产出的 skill 撞名
 * （Skill 表是 @@unique([name, user])）。返回 skill 名。
 */
async function seedDemoSkill(p: any, user: string): Promise<string> {
  const version = skillBundle.version ?? 0;
  const skillRow = await p.skill.create({
    data: {
      name: skillBundle.name,
      category: skillBundle.category || 'Other',
      description: skillBundle.description || null,
      tags: skillBundle.tags ?? null,
      visibility: skillBundle.visibility || 'private',
      author: null,
      user,
      activeVersion: version,
      isUploaded: false,
    },
  });

  // 落盘 SKILL.md + references/scripts，路径约定与 skills/publish 一致：
  //   data/storage/skills/<skillId>/v<version>/...（assetPath 存相对路径，读取时 join(process.cwd())）。
  const storageRel = `data/storage/skills/${skillRow.id}/v${version}`;
  const storageAbs = path.join(process.cwd(), storageRel);
  fs.mkdirSync(storageAbs, { recursive: true });
  fs.writeFileSync(path.join(storageAbs, 'SKILL.md'), skillBundle.content, 'utf-8');
  for (const [rel, content] of Object.entries(skillBundle.assets)) {
    if (rel.includes('..') || path.isAbsolute(rel)) continue; // 防路径穿越（bundle 自产，稳妥起见）
    const dest = path.join(storageAbs, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  }

  await p.skillVersion.create({
    data: {
      skillId: skillRow.id,
      version,
      content: skillBundle.content,
      assetPath: storageRel,
      files: JSON.stringify(skillBundle.files),
      changeLog: skillBundle.changeLog ?? null,
    },
  });

  return skillBundle.name;
}

/**
 * 给新注册用户注入内置示例数据。best-effort：任何失败都吞掉（不阻断登录/注册）。
 * 幂等：demo agent 已存在则直接返回（不重复注入、删了也不补）。
 */
export async function seedBuiltinExampleForUser(user: string): Promise<void> {
  const u = (user || '').trim();
  if (!u) return;
  const p = prisma as any;

  try {
    // 注入标记：该用户的 demo agent 是否已存在。存在即视为已注入过 → 跳过（删了不补）。
    const existingAgent = await p.registeredAgent.findFirst({
      where: { platform: PLATFORM, name: DEMO_AGENT_NAME, user: u },
    });
    if (existingAgent) return;

    // 1. 注册 demo agent，ownership='user' → 这几条 trace 进入「用户 Agent」默认视图。
    const demoAgent = await p.registeredAgent.create({
      data: {
        platform: PLATFORM,
        name: DEMO_AGENT_NAME,
        user: u,
        description: DEMO_AGENT_DESC,
        agentType: 'main',
        agentOwnership: 'user',
      },
    });

    // 1b. 内置 demo skill（这几条 trace 依赖它）。失败不阻断后续（整体 best-effort）。
    let demoSkillName = '';
    try {
      demoSkillName = await seedDemoSkill(p, u);
    } catch (skillErr) {
      console.warn(`[builtin-example] demo skill seed failed for ${u}:`, (skillErr as Error)?.message || skillErr);
    }

    // 2. 内置数据集（targetSkill 关联到 demo skill，便于在 UI 里和该 skill 联动）。
    const nowIso = new Date().toISOString();
    const cases = JSON.parse(fixtures.dataset.casesJson) as DatasetCase[];
    await createAgentDatasetRecord({
      id: randomUUID(),
      user: u,
      name: BUILTIN_DATASET_NAME,
      description:
        String(fixtures.dataset.description || '') ||
        '内置示例数据集：messages 日志安全分析（认证攻击 / SSH 爆破 / 登录异常 等场景）。',
      targetAgent: String(fixtures.dataset.targetAgent || ''),
      targetSkill: demoSkillName || String(fixtures.dataset.targetSkill || ''),
      tags: Array.from(new Set([...safeTags(fixtures.dataset.tagsJson), '内置示例'])),
      cases,
      datasetKind: ((fixtures.dataset.datasetKind as DatasetKind) || 'ideal_output'),
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    // 3. 内置 Trace（2 条成功 + 1 条带报错，用于演示智能诊断）：Session + Execution，挂在 demo agent 名下。
    for (const t of fixtures.traces) {
      if (!t.session || !t.execution) continue;
      const s = t.session as Record<string, any>;
      const e = t.execution as Record<string, any>;
      const taskId = `builtin_msg_${randomUUID().slice(0, 12)}`;

      await p.session.create({
        data: {
          taskId,
          label: s.label ?? null,
          query: s.query ?? null,
          interactions: s.interactions ?? null,
          user: u,
          model: s.model ?? null,
          startTime: toDate(s.startTime) ?? new Date(),
          endTime: toDate(s.endTime) ?? null,
        },
      });

      const metrics: Record<string, unknown> = {};
      for (const f of EXEC_METRIC_FIELDS) if (e[f] != null) metrics[f] = e[f];

      await p.execution.create({
        data: {
          taskId,
          user: u,
          framework: PLATFORM,
          agentName: DEMO_AGENT_NAME,
          agentId: demoAgent.id,
          model: e.model ?? null,
          query: e.query ?? s.query ?? null,
          finalResult: e.finalResult ?? null,
          skill: e.skill ?? null,
          skills: e.skills ?? null,
          invokedSkills: e.invokedSkills ?? null,
          judgmentReason: e.judgmentReason ?? null,
          label: e.label ?? null,
          isAnswerCorrect: !!e.isAnswerCorrect,
          isSkillCorrect: !!e.isSkillCorrect,
          isSubagent: false,
          timestamp: toDate(e.timestamp) ?? new Date(),
          ...metrics,
        },
      });
    }
  } catch (err) {
    console.warn(`[builtin-example] seed failed for user ${u}:`, (err as Error)?.message || err);
  }
}
