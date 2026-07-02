import fs from 'node:fs';
import path from 'node:path';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { getUserSettings, type ModelConfig as ServerModelConfig } from '@/lib/storage/server-config';
import { inferProviderFromBaseUrl, normalizeProviderID } from '@/lib/engine/general-agent/server-model-config';
import { ensureSessionWorkspace, ensureUserWorkspace } from '@/lib/engine/general-agent/workspace';
import { resolveSkill } from '@/lib/engine/general-agent/skill-resolver';
import { resolveRuntimeAssetPath } from '@/lib/env';
import { ensureSkillFilesInWorkspace } from '@/lib/skill-opt-storage';
import {
  buildSkillOptSystemPrompt,
  type SkillOptIssueLite,
  type SkillOptPlanItemLite,
} from '@/lib/engine/general-agent/skill-opt-prompt';
import { scanWorkspaceFiles, type FileData } from '@/lib/skill-generator-opencode-bridge';
import { enforceEditScope } from '@/lib/engine/skill-opt/edit-scope-guard';
import { runSelfVerification, type SelfVerifyResult } from '@/lib/engine/skill-opt/self-verify';
import { findSkillMd } from '@/lib/skill-generator/skill-files';
import type {
  ChatHandlers,
  ModelConfig as OpencodeModelConfig,
} from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';

/**
 * skill-opt 后端胶水层。整体镜像 skill-generator-opencode-bridge.ts，差异点：
 *
 *  1. workspace 预填：runGeneralAgent 之前把 data/storage/skills/<id>/v<N>/ 复制到 cwd，
 *     让 agent read-then-edit 现有文件。同 thread 复用 workspace（多轮 follow-up）。
 *  2. system prompt 走 skill-opt-prompt.ts，把用户勾选的 issues 结构化注入。
 *  3. 不发 download 卡片——前端用 vfs_patch 的最终 files 拼 OptimizationIteration。
 *  4. 进程内 sessionId 缓存（不持久化）——本期不做对话历史。
 */

const SKILL_OPT_AGENT_NAME = 'skill-optimizer-chat';

// 优化器改完后的【自验证】配置。SKILL_OPT_NO_VERIFY=1 整体关。
// 行为门每例 ~1 rollout（含基线共 ~2×，基线带进程缓存），故 MAX_CASES + BUDGET 双重封顶成本。
const VERIFY_REPAIR_K = Number(process.env.SKILL_OPT_VERIFY_REPAIR_K) || 1;       // 自验证失败后最多 repair 几轮
const VERIFY_MAX_CASES = Number(process.env.SKILL_OPT_VERIFY_MAX_CASES) || 5;     // 行为门最多量几例
const VERIFY_BUDGET_YUAN = Number(process.env.SKILL_OPT_VERIFY_BUDGET_YUAN) || 8; // 行为门 ¥ 软上限

/** threadId → opencode sessionId 进程内缓存。重启即失（本期不持久化）。 */
const threadSessionMap = new Map<string, string>();

/** threadId 级串行锁，避免同一 session 并发请求互相踩。 */
const threadInflight = new Map<string, Promise<unknown>>();

async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadInflight.get(threadId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  threadInflight.set(threadId, next);
  try {
    return await next;
  } finally {
    if (threadInflight.get(threadId) === next) {
      threadInflight.delete(threadId);
    }
  }
}

export interface StreamSkillOptOpts {
  user: string;
  threadId: string;
  skillName: string;
  baseVersion: number;
  checkedIssues: SkillOptIssueLite[];
  /** 归并 plan 条目；非空时 prompt 走 plan 注入路径（替代 checkedIssues） */
  planItems?: SkillOptPlanItemLite[];
  userFeedback: string;
  modelId?: string;
  /**
   * Dev fallback：当 data/storage/ 里没有真 skill 文件时（mock 数据场景），
   * 用 caller 提供的这份"基线快照"预填 workspace。键是相对路径（如 "SKILL.md"、
   * "scripts/extract.py"），值是文件全文。生产链路接 DB 后前端不传，自动忽略。
   */
  baselineFiles?: Record<string, string>;
  send: (mode: string, payload: unknown) => void;
}

export interface StreamSkillOptResult {
  agentText: string;
  files: Record<string, FileData>;
  /** workspace 绝对路径，用于调试；前端不消费。 */
  workspaceDir: string;
}

export function streamSkillOptOpencode(
  opts: StreamSkillOptOpts,
): Promise<StreamSkillOptResult> {
  return withThreadLock(opts.threadId, () => streamSkillOptOpencodeImpl(opts));
}

async function streamSkillOptOpencodeImpl(
  opts: StreamSkillOptOpts,
): Promise<StreamSkillOptResult> {
  const { user, threadId, skillName, baseVersion, checkedIssues, planItems, userFeedback, modelId, baselineFiles, send } = opts;

  console.log('[skill-opt-bridge] start', {
    user, threadId, skillName, baseVersion,
    issuesCount: checkedIssues.length, planItemsCount: planItems?.length ?? 0,
    feedbackLen: userFeedback.length,
    baselineFiles: baselineFiles ? Object.keys(baselineFiles).length : 0,
  });

  // ── 1. workspace 准备（首次调用时从 storage 拷文件，找不到则用 baselineFiles 兜底）──
  ensureUserWorkspace(user);
  const workspaceDir = ensureSessionWorkspace(user, threadId);
  // 权威存储目录：按 skill 真实 id + SkillVersion.assetPath 解析（复用测量路径
  // runGeneralAgent→resolveSkill→deploySkillToWorkspace 用的同一个 resolveSkill），
  // 让"优化器预填的基线"与"被测的基线"指向同一目录。解析不到（DB 无此 skill /
  // 无 assetPath / 目录不在盘上）返回 null，下游回退到 name-scan / baselineFiles。
  const storageDirOverride = await resolveAuthoritativeStorageDir(user, skillName, baseVersion);
  const prefilled = ensureSkillFilesInWorkspace({ skillName, baseVersion, workspaceDir, baselineFiles, storageDirOverride });
  if (prefilled.copied > 0) {
    console.log('[skill-opt-bridge] prefilled workspace:', prefilled);
  }
  // 把预填后的 VFS 推一次给前端，让 diff 能立刻渲染基线（即便 agent 还没改）
  // 同时把这份"基线快照"留存——收尾时用它做编辑范围硬约束（防优化器删/大改既有资产）。
  let baselineVfs: Record<string, FileData> = {};
  try {
    baselineVfs = scanWorkspaceFiles(workspaceDir);
    if (Object.keys(baselineVfs).length > 0) {
      send('vfs_patch', { files: baselineVfs });
    }
  } catch {
    /* 扫描失败不阻塞——agent 跑完还会再扫一次 */
  }

  // ── 2. 模型配置 ────────────────────────────────────────────────────────────
  const modelOverride = await resolveModelOverride(user, modelId);

  // ── 3. system prompt ───────────────────────────────────────────────────────
  const systemPrompt = buildSkillOptSystemPrompt({
    skillName, baseVersion, checkedIssues, userFeedback, planItems,
  });

  // ── 4. SSE handlers + watchdog（直接抄 skill-generator 的）──────────────────────
  // watchdog：第一个业务事件来了才计时；空闲一段时间自动 abort 让 chat() 立即收尾。
  // skill-opt 比 skill-generator 长——agent 要 read 多个文件 → 思考 → edit 多处，
  // LLM 在两次 tool 间可能停顿 10-20s 不冒泡。skill-generator 12s 在这场景下经常误切。
  const IDLE_BAILOUT_MS = 30_000;
  const chatAbortController = new AbortController();
  let idleWatchdog: NodeJS.Timeout | null = null;
  const armIdleWatchdog = () => {
    if (idleWatchdog) clearTimeout(idleWatchdog);
    idleWatchdog = setTimeout(() => chatAbortController.abort(), IDLE_BAILOUT_MS);
  };

  let agentText = '';
  let openThinkingId: string | null = null;
  const reasoningFullByThinkId = new Map<string, string>();
  const announcedTools = new Set<string>();
  let vfsAccum: Record<string, FileData> = {};
  // 同一个错误 onSession(phase='error') 与 onError 都会触发——dedup 避免给前端推两条
  const errorsSent = new Set<string>();
  const sendErrorOnce = (msg: string) => {
    if (errorsSent.has(msg)) return;
    errorsSent.add(msg);
    try { send('error', msg); } catch { /* stream closed */ }
  };

  const closeThinkingIfOpen = () => {
    if (openThinkingId) {
      send('thinking', { id: openThinkingId, done: true });
      openThinkingId = null;
    }
  };

  const handlers: ChatHandlers = {
    onText: (e) => {
      armIdleWatchdog();
      closeThinkingIfOpen();
      agentText += e.delta;
      send('text', e.delta);
    },
    onReasoning: (e) => {
      armIdleWatchdog();
      if (!e.delta) return;
      if (!openThinkingId) {
        openThinkingId = `think_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }
      // fullText 单调递增去重——防止 message.part.delta + message.part.updated 双路径重发
      const lastFull = reasoningFullByThinkId.get(openThinkingId) ?? '';
      const incomingFull = e.fullText && typeof e.fullText === 'string'
        ? e.fullText
        : lastFull + e.delta;
      if (incomingFull.length <= lastFull.length) return;
      const realDelta = incomingFull.startsWith(lastFull)
        ? incomingFull.slice(lastFull.length)
        : e.delta;
      reasoningFullByThinkId.set(openThinkingId, incomingFull);
      send('thinking', { id: openThinkingId, delta: realDelta });
    },
    onTool: (e) => {
      armIdleWatchdog();
      const id = e.callID || e.partID;
      if (!id) return;
      // 关键：opencode 的 tool 事件有 start/delta/end/error 四个 phase。input 是流式累加的
      // （特别是 todowrite 这种 args 大的工具，todos 数组通过 delta 逐步建出来）。
      // start 时 input 可能为空/半截，delta 中持续填充，end 时才完整。所以每个 phase
      // 都要把最新 e.input 推给前端，让前端的 args 状态保持最新。
      if (e.phase === 'start') {
        if (!announcedTools.has(id)) {
          announcedTools.add(id);
          closeThinkingIfOpen();
        }
        send('tool_call', { id, name: e.name, args: e.input, status: 'running' });
      } else if (e.phase === 'delta') {
        // input 又长了一截——再发一次 tool_call 让前端覆盖更新 args
        if (!announcedTools.has(id)) {
          announcedTools.add(id);
          closeThinkingIfOpen();
        }
        send('tool_call', { id, name: e.name, args: e.input, status: 'running' });
      } else if (e.phase === 'end') {
        if (!announcedTools.has(id)) {
          announcedTools.add(id);
          send('tool_call', { id, name: e.name, args: e.input, status: 'running' });
        } else {
          // 终态再推一次最完整的 args，避免 delta 落帧
          send('tool_call', { id, name: e.name, args: e.input, status: 'running' });
        }
        send('tool_result', {
          id,
          status: e.status === 'error' ? 'error' : 'ok',
          summary: stringifyToolOutput(e.output),
        });
      } else if (e.phase === 'error') {
        if (!announcedTools.has(id)) {
          announcedTools.add(id);
          send('tool_call', { id, name: e.name, args: e.input, status: 'running' });
        }
        send('tool_result', {
          id,
          status: 'error',
          error: stringifyToolOutput((e as any).error) || 'tool error',
        });
      }
    },
    onFileEdited: () => {
      armIdleWatchdog();
      try {
        vfsAccum = scanWorkspaceFiles(workspaceDir);
        send('vfs_patch', { files: vfsAccum });
      } catch {
        /* 扫描出错忽略，done 前还会再扫一次 */
      }
    },
    // skill-generator 抄来的"完成即 abort"路径是它的外部兜底（防 deepseek 偶发不填
    // info.time.completed 让 chat() 永远不结束）。但 onAssistantMessage(completed) 是
    // **单条**助手消息结束的信号——每轮 LLM 调用都触发，包括"调完工具准备进下一轮"那条
    // （finish: "tool-calls"）。skill-generator 没暴雷是因为它的 skill-generator 结构上就是
    // 单轮（一口气 write 所有文件），整次响应只有一条 completed。
    //
    // skill-opt 是真多轮（read → 思考 → edit → 思考 → 收尾），所以这里复刻 opencode-client
    // 内部对 finishReason 的判断（见 opencode-client.ts:1422-1430）：只在终止性 finish
    // 时才 abort，"tool-calls"（本轮要继续）放行。
    onAssistantMessage: (e) => {
      if (e.status === 'error') {
        setTimeout(() => chatAbortController.abort(), 500);
        return;
      }
      if (e.status !== 'completed') return;
      const finish = (e.info as any)?.finish ?? (e.info as any)?.finishReason;
      // 没拿到 finish（少见——provider 没填）按"可能要继续"处理，不 abort，让 watchdog 兜底
      if (typeof finish !== 'string') return;
      if (finish === 'tool-calls') return;  // 本轮调了工具，下一轮还要 LLM
      // stop / length / content-filter 等终止性原因
      setTimeout(() => chatAbortController.abort(), 500);
    },
    onSession: (e) => {
      // session.idle 才是真正的"任务彻底空闲"信号——所有助手消息都完成、没有更多 LLM 调用了。
      // 这条对 skill-opt 也是安全的终止依据。延迟 500ms 让最后一批 file_edited / tool_result 落地。
      if (e.phase === 'idle') {
        setTimeout(() => chatAbortController.abort(), 500);
      }
      if (e.phase === 'error') {
        const errMsg = formatSessionError((e as any).error);
        console.error('[skill-opt-bridge] session.error:', errMsg);
        sendErrorOnce(errMsg);
      }
    },
    // skill-opt 不需要 ask user 工具——auto-allow 下 agent 不会问
    // 万一问了就直接给 null 回退，避免卡死
    onQuestion: async () => null,
    // 通用 onError——chat()内部的所有错误（除了session.error外，包括message-level错误、
    // pipeline崩溃等）都会从这里走。session.error 路径会同时触发 onSession + onError，
    // 所以这里要去重。Set tracks 已发送过的错误文本。
    onError: (err) => {
      const msg = err?.message || String(err);
      console.error('[skill-opt-bridge] chat onError:', msg);
      sendErrorOnce(msg);
    },
  };

  // ── 5. 调 runGeneralAgent ──────────────────────────────────────────────────
  const cachedSessionId = threadSessionMap.get(threadId);
  console.log('[skill-opt-bridge] cachedSessionId:', cachedSessionId || '(none)');

  // 前台 skill-opt 交互式: displayOnly=true, 仅 dashboard 可见, 不占 5-slot 配额。
  // skill-opt 是用户在 web 端编辑 skill 时实时跑的, 不能被后台 A/B 批量卡住。
  const slotMeta = {
    taskType: 'skill-opt' as const,
    user,
    label: `skill-opt · ${skillName} v${baseVersion}`,
    skill: skillName,
    skillVersion: baseVersion,
    displayOnly: true,
  };
  let result;
  try {
    result = await withBackgroundOpencodeSlot(
      () => runGeneralAgent({
        user,
        query: composeUserQuery(checkedIssues, userFeedback, planItems),
        sessionId: cachedSessionId,
        workspaceTag: threadId,
        sessionTitle: `skill-opt · ${skillName} v${baseVersion} · ${threadId.slice(0, 8)}`,
        system: systemPrompt,
        chatOptions: {
          idleTimeoutMs: 30_000,
          streamTimeoutMs: 15 * 60 * 1000,
          signal: chatAbortController.signal,
        },
        systemAgentName: SKILL_OPT_AGENT_NAME,
        interactionPolicy: 'auto-allow',
        ...(modelOverride ? { model: modelOverride } : {}),
        handlers,
      }),
      slotMeta,
    );
  } catch (err) {
    // 复用 session 失效时换新 session 重试一次（与 skill-generator 一致的兜底）
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[skill-opt-bridge] runGeneralAgent threw:', msg);
    if (cachedSessionId && /session/i.test(msg)) {
      threadSessionMap.delete(threadId);
      console.log('[skill-opt-bridge] retrying without cachedSessionId...');
      result = await withBackgroundOpencodeSlot(
        () => runGeneralAgent({
          user,
          query: composeUserQuery(checkedIssues, userFeedback, planItems),
          workspaceTag: threadId,
          sessionTitle: `skill-opt · ${skillName} v${baseVersion} · ${threadId.slice(0, 8)}`,
          system: systemPrompt,
          interactionPolicy: 'auto-allow',
          ...(modelOverride ? { model: modelOverride } : {}),
          handlers,
        }),
        slotMeta,
      );
    } else {
      throw err;
    }
  }

  if (idleWatchdog) clearTimeout(idleWatchdog);
  threadSessionMap.set(threadId, result.sessionId);
  closeThinkingIfOpen();

  // ── 编辑范围硬约束（结构性，不依赖 prompt——实测强模型会无视"别删脚本"的提示）──
  // 借鉴 trace2skill 的"有界编辑"：默认禁止删除基线已有文件（优化器常把关键脚本整删/整重写，
  // 损失远大于收益）。删了就还原，并发一条 warning 让前端可见。可用 SKILL_OPT_NO_PROTECT=1 关闭。
  // 同时统计改动行数，超 SKILL_OPT_MAX_CHANGED_LINES（默认不限）时告警（不自动回滚，交 gate/用户裁决）。
  if (process.env.SKILL_OPT_NO_PROTECT !== '1') {
    const guard = enforceEditScope(result.workspaceDir, baselineVfs, {
      maxChangedLines: Number(process.env.SKILL_OPT_MAX_CHANGED_LINES) || 0,
    });
    if (guard.restored.length > 0) {
      console.warn('[skill-opt-bridge] edit-scope guard restored deleted baseline files:', guard.restored);
      send('warning', { kind: 'edit_scope', message: `优化器删除了基线文件，已自动还原：${guard.restored.join(', ')}`, restored: guard.restored });
    }
    if (guard.changedLines > 0 && guard.overBudget) {
      console.warn(`[skill-opt-bridge] edit-scope: changed ${guard.changedLines} lines, over budget`);
      send('warning', { kind: 'edit_scope', message: `本次改动 ${guard.changedLines} 行，超过预算上限`, changedLines: guard.changedLines });
    }
  }

  // ── 自验证（自动）：结构门 + 行为重评，失败则 repair（复用同一 opencode session）──
  // 开环链路的补门：优化器「改完直接落版本、从不校验对不对」是年份 bug 等「编译过却答错」
  // 回归的温床。这里在收尾前自动验一遍，回归就把具体问题喂回还活着的 session 让 agent 修。
  if (process.env.SKILL_OPT_NO_VERIFY !== '1') {
    try {
      for (let attempt = 0; attempt <= VERIFY_REPAIR_K; attempt++) {
        const current = scanWorkspaceFiles(result.workspaceDir);
        // FileData.content 是 string[]，归一成字符串并适配 findSkillMd 的 PlaygroundFiles 形态
        const vfs: Record<string, { content: string }> = {};
        for (const [key, fd] of Object.entries(current)) {
          vfs[key] = { content: Array.isArray(fd.content) ? fd.content.join('\n') : String((fd as { content?: unknown }).content ?? '') };
        }
        const skillMd = findSkillMd(vfs);
        if (!skillMd) { send('warning', { kind: 'self_verify', message: '自验证跳过：workspace 里找不到 SKILL.md' }); break; }
        // workspace VFS（/workspace/<folder>/...）→ 技能根相对（SKILL.md 在根），同 apply 落盘口径
        const folderPrefix = skillMd.folder ? `${skillMd.folder}/` : '';
        const candidateFiles: Record<string, string> = {};
        for (const [key, f] of Object.entries(vfs)) {
          if (!key.startsWith('/workspace/')) continue;
          let rel = key.slice('/workspace/'.length);
          if (folderPrefix) { if (!rel.startsWith(folderPrefix)) continue; rel = rel.slice(folderPrefix.length); }
          if (rel) candidateFiles[rel] = f.content;
        }
        send('verify_progress', { message: attempt === 0 ? '开始自验证（结构门 + 行为重评）…' : `repair 第 ${attempt} 轮后重新自验证…` });
        const verdict: SelfVerifyResult = await runSelfVerification({
          user, skillName, baseVersion,
          candidateSkillMd: skillMd.content, candidateFiles,
          maxCases: VERIFY_MAX_CASES, budgetYuan: VERIFY_BUDGET_YUAN,
          onProgress: (m) => send('verify_progress', { message: m }),
        });
        if (verdict.ok) {
          const beh = verdict.behavioral;
          send('verify_ok', {
            structural: verdict.structural.ok,
            behavioral: beh ? { baseMean: beh.baseMean, candMean: beh.candMean, delta: beh.delta, measured: beh.measured, skipped: beh.skipped } : null,
          });
          break;
        }
        if (attempt >= VERIFY_REPAIR_K) {
          send('warning', { kind: 'self_verify', message: `自验证仍未通过（已 repair ${VERIFY_REPAIR_K} 轮），保留当前结果供你裁决：${verdict.failures.join('；')}` });
          break;
        }
        // 还有 repair 额度：把失败喂回同一 session 让 agent 修
        send('warning', { kind: 'self_verify', message: `自验证未通过，自动 repair（第 ${attempt + 1}/${VERIFY_REPAIR_K} 轮）：${verdict.failures.join('；')}` });
        try {
          await withBackgroundOpencodeSlot(
            () => runGeneralAgent({
              user, query: buildSelfVerifyRepairQuery(verdict),
              sessionId: result.sessionId, workspaceTag: threadId,
              sessionTitle: `skill-opt repair · ${skillName} v${baseVersion} · ${threadId.slice(0, 8)}`,
              system: systemPrompt, interactionPolicy: 'auto-allow',
              ...(modelOverride ? { model: modelOverride } : {}),
              handlers,
            }),
            slotMeta,
          );
        } catch (e) {
          console.warn('[skill-opt-bridge] repair turn failed:', (e as Error)?.message);
          send('warning', { kind: 'self_verify', message: 'repair 回合执行失败，保留当前结果' });
          break;
        }
      }
    } catch (e) {
      console.warn('[skill-opt-bridge] self-verify errored (non-blocking):', (e as Error)?.message);
    }
  }

  // 兜底全量扫描，最终一次 VFS 推送
  vfsAccum = scanWorkspaceFiles(result.workspaceDir);
  send('vfs_patch', { files: vfsAccum });
  send('done', { reason: 'completed' });

  console.log('[skill-opt-bridge] done', {
    sessionId: result.sessionId,
    outputLen: result.output.length,
    agentTextLen: agentText.length,
    fileCount: Object.keys(vfsAccum).length,
  });

  return { agentText, files: vfsAccum, workspaceDir: result.workspaceDir };
}

// ── workspace 预填 ─────────────────────────────────────────────────────────────
// 纯 fs 的预填/存储解析机制（ensureSkillFilesInWorkspace / resolveSkillStorageDirSync /
// writeBaselineFiles）已拆到 ./skill-opt-storage，便于单测且与本文件的 opencode 重依赖解耦。
// 这里只留需要 DB 的"权威目录解析"。

/**
 * 按 skill 真实 id 解析 baseVersion 的【权威】存储目录绝对路径。
 *
 * 复用 resolveSkill——即测量路径（runGeneralAgent → resolveSkill →
 * deploySkillToWorkspace）所用的同一个解析器——拿到 SkillVersion.assetPath，
 * 再按 deploySkillToWorkspace 同款运行时 assetPath 解析落到绝对目录。
 * 这样"优化器预填的基线"与"被测的基线"恒等同一目录（包括 version 回退场景：
 * resolveSkill 找不到精确 baseVersion 时回退 active/latest，与测量端口径一致）。
 *
 * 任何一步缺失——DB 无此 skill / 该版本无 assetPath / assetPath 指向的目录不在盘上——
 * 都返回 null，让 ensureSkillFilesInWorkspace 回退到 legacy name-scan / baselineFiles
 * （dev/mock：DB 里没有但盘上按 name 存了文件，或前端直接喂 baselineFiles）。
 */
async function resolveAuthoritativeStorageDir(
  user: string,
  skillName: string,
  baseVersion: number,
): Promise<string | null> {
  try {
    const skill = await resolveSkill(skillName, user, baseVersion);
    const assetPath = skill?.assetPath;
    if (!assetPath || typeof assetPath !== 'string') return null;
    const abs = resolveRuntimeAssetPath(assetPath);
    return fs.existsSync(abs) ? abs : null;
  } catch (err) {
    console.warn('[skill-opt-bridge] authoritative storageDir resolve failed:', (err as Error)?.message);
    return null;
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 把自验证失败拼成给优化器 agent 的 repair 指令（喂回还活着的 session）。 */
function buildSelfVerifyRepairQuery(v: SelfVerifyResult): string {
  const parts: string[] = ['你刚才的修改没通过自验证，请据下面的问题修复（修完我会再自动验一遍）：'];
  if (!v.structural.ok) {
    parts.push('【结构问题】\n' + v.structural.failures.map((f) => '- ' + f).join('\n'));
  }
  if (v.behavioral && !v.behavioral.ok) {
    parts.push(`【行为回归】在评测用例上净分 ${v.behavioral.baseMean}→${v.behavioral.candMean}（Δ${v.behavioral.delta}）。以下用例改后掉分（含原本答对的）：`);
    for (const r of v.behavioral.regressions) parts.push(`- ${r.caseId.slice(0, 8)} ${r.base}→${r.cand}：${r.reason}`);
  }
  parts.push(
    '修复要求：① SKILL.md 引用的每个脚本/参考文件都要真实写出且能编译（py_compile / node --check）；'
    + '② 别让原本答对的用例掉分；③ 定量结论（年份/计数/IP 等）必须来自脚本对真实日志的解析、逐字引用，'
    + '禁止编造、禁止用当前系统年份（如日志真实年份是 2005，就不能输出 2026）。只改必要部分，不要整文件重写。',
  );
  return parts.join('\n');
}

function composeUserQuery(issues: SkillOptIssueLite[], userFeedback: string, planItems?: SkillOptPlanItemLite[]): string {
  // system prompt 已包含 issues/plan 全部细节；query 只放一个简短的"开干"指令 + 用户原文，
  // 避免 LLM 把 system 当背景 / query 当主输入时漏掉哪一边。
  const lines: string[] = [];
  if (planItems && planItems.length > 0) {
    lines.push(`请按 system 提示中的优化计划逐条执行（共 ${planItems.length} 条）。`);
  } else if (issues.length > 0) {
    lines.push(`请按 system 提示中列出的 ${issues.length} 个 issue 进行优化。`);
  }
  if (userFeedback.trim()) {
    lines.push('用户附加说明：');
    lines.push(userFeedback.trim());
  }
  if (lines.length === 0) {
    lines.push('（用户没勾 issue 也没填诉求，请先看一下 SKILL.md，给一些改进建议而不是直接动文件。）');
  }
  return lines.join('\n\n');
}

async function resolveModelOverride(
  user: string,
  modelId?: string,
): Promise<OpencodeModelConfig | null> {
  if (!modelId) return null;
  const settings = await getUserSettings(user);
  const cfg: ServerModelConfig | undefined = settings.configs.find((c) => c.id === modelId);
  if (!cfg || !cfg.apiKey) return null;
  const explicitProvider = (cfg as { provider?: string }).provider;
  const providerID = normalizeProviderID(explicitProvider || inferProviderFromBaseUrl(cfg.baseUrl));
  return {
    providerID,
    modelID: cfg.model || 'deepseek-chat',
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  };
}

function stringifyToolOutput(output: unknown): string {
  // 1500 字符上限：足够展开看到目录列表 / 文件读取的几十行预览，又不至于把 5MB 的整文件
  // 都塞进 SSE 事件流。前端 ToolBlock 折叠默认只显示 first-line preview，展开才铺全。
  const CAP = 1500;
  if (output == null) return '';
  if (typeof output === 'string') return output.length > CAP ? output.slice(0, CAP) + `\n…[truncated, +${output.length - CAP} chars]` : output;
  try {
    const s = JSON.stringify(output, null, 2);
    return s.length > CAP ? s.slice(0, CAP) + `\n…[truncated, +${s.length - CAP} chars]` : s;
  } catch {
    return String(output).slice(0, CAP);
  }
}

/**
 * opencode session.error 的 error 字段格式：可能是 string，可能是 { name, message, ... }，
 * 也可能是嵌套结构（provider 错误透传）。尽量抠出可读信息给用户。
 */
function formatSessionError(err: unknown): string {
  if (!err) return 'session 错误（无详情）';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const msg = o.message || o.error || (o.data as any)?.message;
    if (typeof msg === 'string') return msg;
    try { return JSON.stringify(err).slice(0, 500); } catch { return String(err); }
  }
  return String(err);
}

// 给测试用的 internal helper 导出（生产代码不要直接调）。
// 预填/存储解析的纯 fs 部分见 ./skill-opt-storage（直接 named export，单测从那边导入）。
export const __testing = {
  resolveAuthoritativeStorageDir,
  composeUserQuery,
};
