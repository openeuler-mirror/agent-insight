import { prismaRaw } from '@/lib/storage/prisma';

/**
 * 系统内置 Agent 注册表。
 *
 * 这些 Agent 由服务"自身代码"驱动（skill-generator 后端、轨迹评估器、技能优化器等），
 * 不来自终端用户的 trace 上报。每个 Agent 在启动时通过 instrumentation.ts 自动 upsert
 * 到 RegisteredAgent 表，`agentOwnership='system'`，新部署 / 全新数据库都立即可见。
 *
 * 添加新系统 Agent：在 SYSTEM_AGENTS 数组里加一项即可，server 重启就会自动注册。
 */

export interface SystemAgentDefinition {
  /** opencode / claudecode / openclaw 等。决定该 Agent 在哪类 trace 里出现。 */
  platform: string;
  /** Agent 名（同 platform 下唯一）。也是 Execution.agentName 的取值。 */
  name: string;
  /** 给运营 / 用户看的描述。 */
  description: string;
  /** 'main' or 'subagent'，影响 UI 上的层级展示。绝大多数 main。 */
  agentType?: 'main' | 'subagent';
  /**
   * trace 上报到 /api/ingest/upload 时填到 Execution.skill 列的标签——通常是该 Agent
   * 用的内置 skill 名（与 skills/<name>/SKILL.md 对应）。仅作 trace 显示用，与运行时
   * 是否真的从 DB 加载 skill 无关。不填则 plugin 自动提取的 skill 不被覆盖。
   */
  traceSkill?: string;
  /**
   * 历史用过的旧 name。ensureSystemAgent 找不到新名时会按这里的名字回查 DB，
   * 找到就**就地把那行的 name 字段 update 成新名**——历史 Execution 通过 cuid 还连着同一行，
   * UI 上不会出现"一个逻辑 agent 占两行"的脏状态。改名后保留旧名一段过渡期，下一轮清理可移除。
   */
  previousNames?: string[];
}

export const SYSTEM_AGENTS: SystemAgentDefinition[] = [
  {
    platform: 'opencode',
    name: 'skill-generator-agent',
    description:
      '内置：基于 opencode + skills/skill-generator/SKILL.md 的 Skill 生成 Agent（Skills 生成页后端）',
    agentType: 'main',
    traceSkill: 'skill-generator',
    previousNames: ['playground-skill-generator'],
  },
  {
    platform: 'opencode',
    name: 'fault-diagnosis-agent',
    description: '内置：故障定位详情页中的 OpenCode 智能诊断对话 Agent',
    agentType: 'main',
    traceSkill: 'fault-diagnosis',
  },
  {
    platform: 'opencode',
    name: 'skill-debug-executor',
    description: '内置：Skill 调试页批量用例执行 Agent（auto-allow 模式，异步后台运行）',
    agentType: 'main',
  },
  {
    platform: 'opencode',
    name: 'grayscale-skill-agent',
    description: '内置：灰度测评 B 侧 Skill 执行 Agent（后台非交互运行，权限/提问请求直接拒绝并归类失败）。',
    agentType: 'main',
  },
  {
    platform: 'opencode',
    name: 'grayscale-baseline-agent',
    description: '内置：灰度测评 A 侧基线 Agent（不加载 Skill，后台非交互运行，权限/提问请求直接拒绝并归类失败）。',
    agentType: 'main',
  },
  {
    platform: 'opencode',
    name: 'skill-optimizer-chat',
    description: '内置：skill-opt 页面的交互式优化 Agent（用户勾选 issue + 文字诉求 → agent 就地修改 skill 文件）',
    agentType: 'main',
    traceSkill: 'skill-optimizer',
  },
  {
    platform: 'opencode',
    name: 'trace-quality-evaluator',
    description: '内置：Agent 轨迹质量评估器（基于 opencode 单主评估器评估执行轨迹）',
    agentType: 'main',
  },
  {
    platform: 'opencode',
    name: 'task-completion-evaluator',
    description: '内置：Agent 任务完成度评估器（基于 opencode 评测最终输出是否完成用户目标）',
    agentType: 'main',
  },
  {
    platform: 'opencode',
    name: 'skill-trigger-analyzer',
    description: '内置：Skill 触发分析评测 Agent（read-only 模式跑触发集，与用例评估 trace 分流）',
    agentType: 'main',
    previousNames: ['skill-recall-analyzer'],
  },
  // 后续：skill-optimizer 等内置 agent
  // 加新 Agent 时同时填 traceSkill（如果有内置 skill），server 重启自动注册
];

/** 进程内缓存：(platform, name) → cuid。命中后直接返回，避免每次访问都查库。 */
const idCache = new Map<string, string>();

function cacheKey(platform: string, name: string): string {
  return `${platform}::${name}`;
}

/**
 * Idempotent upsert 一个系统 Agent，返回其 cuid（DB 失败时返回 null）。
 *
 * 用 (platform, name, user=null) 作为唯一键。schema 上的 @@unique([platform, name, user])
 * 确保不会重复创建。description 改了下次启动会自动同步。
 */
export async function ensureSystemAgent(
  def: SystemAgentDefinition,
): Promise<string | null> {
  const key = cacheKey(def.platform, def.name);
  const cached = idCache.get(key);
  if (cached) return cached;

  try {
    let existing = await (prismaRaw as any).registeredAgent.findFirst({
      where: { platform: def.platform, name: def.name, user: null },
    });

    // 找不到新名 → 回查 previousNames，找到就**就地把那行 name 改成新名**。
    // 这样历史 Execution（通过 cuid 外键绑那行）UI 上自然展示新名，避免一个逻辑 agent 占两行。
    if (!existing && def.previousNames?.length) {
      for (const oldName of def.previousNames) {
        const row = await (prismaRaw as any).registeredAgent.findFirst({
          where: { platform: def.platform, name: oldName, user: null },
        });
        if (row) {
          try {
            await (prismaRaw as any).registeredAgent.update({
              where: { id: row.id },
              data: { name: def.name },
            });
            existing = { ...row, name: def.name };
            console.log(`[system-agents] renamed ${def.platform}/${oldName} → ${def.name}`);
          } catch (renameErr) {
            // unique(platform, name, user) 冲突（极少见：另一进程刚刚创建了新名行）→ 走正常 findFirst 路径兜底
            console.warn(`[system-agents] rename ${oldName} → ${def.name} failed:`, (renameErr as Error)?.message);
          }
          break;
        }
      }
    }

    if (existing) {
      // 如果已存在且标记为 unregistered，或者描述变了，则更新同步。
      const needsUpdate = existing.agentOwnership === 'unregistered' || existing.description !== def.description;
      if (needsUpdate) {
        await (prismaRaw as any).registeredAgent.update({
          where: { id: existing.id },
          data: {
            description: def.description,
            agentOwnership: 'system',
            agentType: def.agentType ?? 'main',
          },
        });
      }

      // 额外的清理工作：删除可能存在的其他同名但标记为 unregistered 的记录（不同 user 产生的）
      // 系统 Agent 应该是全局唯一的。
      try {
        await (prismaRaw as any).registeredAgent.deleteMany({
          where: {
            platform: def.platform,
            name: def.name,
            agentOwnership: 'unregistered',
            id: { not: existing.id },
          },
        });
      } catch (_e) {
        // ignore delete errors
      }

      idCache.set(key, existing.id);
      return existing.id;
    }
    const created = await (prismaRaw as any).registeredAgent.create({
      data: {
        platform: def.platform,
        name: def.name,
        user: null,
        description: def.description,
        agentType: def.agentType ?? 'main',
        agentOwnership: 'system',
      },
    });
    idCache.set(key, created.id);
    return created.id;
  } catch (err) {
    console.warn(
      `[system-agents] upsert ${def.platform}/${def.name} failed:`,
      (err as Error)?.message,
    );
    return null;
  }
}

/** 启动时一次性注册所有系统 Agent。失败的那些不阻塞别的，独立 catch。 */
export async function ensureAllSystemAgents(): Promise<void> {
  await Promise.all(SYSTEM_AGENTS.map((d) => ensureSystemAgent(d).catch(() => null)));
}

/** 按名字快速拿 cuid（skill-generator / 评估器 等运行时写 Execution 时用）。 */
export async function getSystemAgentId(
  platform: string,
  name: string,
): Promise<string | null> {
  const key = cacheKey(platform, name);
  const cached = idCache.get(key);
  if (cached) return cached;
  const def = SYSTEM_AGENTS.find((d) => d.platform === platform && d.name === name);
  if (!def) return null;
  return ensureSystemAgent(def);
}

/** 同步查找系统 Agent 的静态定义（含 traceSkill 等元数据）。找不到返回 undefined。 */
export function findSystemAgentDefinition(
  platform: string,
  name: string,
): SystemAgentDefinition | undefined {
  return SYSTEM_AGENTS.find((d) => d.platform === platform && d.name === name);
}
