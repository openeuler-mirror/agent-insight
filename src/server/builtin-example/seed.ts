/**
 * 新用户注册时一次性注入的「内置示例数据」。
 *
 * 在 /api/auth/apikey 首次创建 User 后调用 seedBuiltinExampleForUser(user)：
 *   - 1 个内置数据集「messages 日志分析（内置示例）」(ideal_output, 10 cases)
 *   - 2 条内置链路追踪 Trace (Session + Execution)，挂在一个 ownership='user' 的
 *     demo agent (messages-log-analyzer) 名下，使其落到链路追踪页默认的「用户 Agent」
 *     视图里（其他用户/系统/评测器 trace 不受影响——ownership 按 (platform,name) 解析，
 *     而这个 agent 名只被这两条 demo trace 使用）。
 *
 * 语义：只在「用户从未被注入过」时执行一次（标记 = demo agent 是否存在）。
 * 用户之后删掉示例数据，不会再补回来——因为本函数只在 createUser 成功（新用户）时被调一次。
 *
 * 数据来源：src/server/builtin-example/fixtures.json，由 messages 日志分析 数据集 +
 * 两条真实 messages 分析 trace 导出（见该目录 README 注释）。
 */
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/storage/prisma';
import { createAgentDatasetRecord, type DatasetCase, type DatasetKind } from '@/server/agent_datasets_storage';
import fixturesRaw from './fixtures.json';

const fixtures = fixturesRaw as {
  dataset: Record<string, unknown> & { casesJson: string };
  traces: Array<{ taskId: string; session: Record<string, unknown> | null; execution: Record<string, unknown> | null }>;
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

    // 1. 注册 demo agent，ownership='user' → 这两条 trace 进入「用户 Agent」默认视图。
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

    // 2. 内置数据集。
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
      targetSkill: String(fixtures.dataset.targetSkill || ''),
      tags: Array.from(new Set([...safeTags(fixtures.dataset.tagsJson), '内置示例'])),
      cases,
      datasetKind: ((fixtures.dataset.datasetKind as DatasetKind) || 'ideal_output'),
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    // 3. 两条内置 Trace：Session + Execution，挂在 demo agent 名下。
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
