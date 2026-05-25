import fs from 'node:fs';
import path from 'node:path';
import { runGeneralAgent } from '@/lib/engine/general-agent';
import { getUserSettings, type ModelConfig as ServerModelConfig } from '@/lib/storage/server-config';
import { inferProviderFromBaseUrl } from '@/lib/engine/general-agent/server-model-config';
import {
  loadFileBasedSkillPrompt,
  fileBasedSkillExists,
  mountFileBasedSkillResources,
} from '@/lib/engine/general-agent/skills-fs-loader';
import { normalizeProviderID } from '@/lib/engine/general-agent/server-model-config';
import {
  ensureSessionWorkspace,
  ensureUserWorkspace,
} from '@/lib/engine/general-agent/workspace';
import { awaitInteraction } from '@/lib/engine/general-agent/pending-requests';
import { getOpencodeServerGeneration } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager';
import {
  listAttachments,
  formatAttachmentsForPrompt,
  UPLOADS_DIR,
} from '@/lib/skill-generator/attachments';
import { prismaRaw } from '@/lib/storage/prisma';
import type {
  ChatHandlers,
  ModelConfig as OpencodeModelConfig,
} from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';

/**
 * Skill-Generator 后端从 deepagents 迁到 opencode 的胶水层。
 *
 *  - 把 skill-generator 期望的事件协议（text/thinking/tool_call/tool_result/vfs_patch/download/done）
 *    翻译成 opencode runtime 的事件流。
 *  - 把 opencode 写到 workspace 真实磁盘的文件，扫描成 skill-generator 的 /workspace/<rel> VFS 形态。
 *  - 维护 threadId ↔ opencode sessionId 的进程内映射（重启即失，对话内上下文需重新累积）。
 */

/** 内置 skill 名：skill-generator 走 file-based 加载，从 skills/ 目录直接读 SKILL.md。 */
const SKILL_GENERATOR_SKILL_NAME = 'skill-generator';

/**
 * skill-generator 对应的系统 Agent 名（platform='opencode'）。
 * 实际记录在 src/lib/system-agents.ts 的 SYSTEM_AGENTS 列表里，server 启动时 instrumentation
 * 会预注册；这里只用名字写到 Execution.agentName 字段。
 */
const SKILL_GENERATOR_AGENT_NAME = 'skill-generator-agent';

/**
 * 兜底 system prompt：仅当 skills/skill-generator/SKILL.md 不存在时使用。
 * 正常情况下绝对不会走这条分支——保留是为了"哪怕项目结构改了也别让 skill-generator 直接挂"。
 */
const SKILL_GENERATOR_FALLBACK_PROMPT = `你是 Witty Skill 专家助手。任务是协助用户从零开始构建一个高质量的 Agent Skill 包，写到当前工作目录的相对路径下（SKILL.md / scripts/ / references/）。SKILL.md 含 YAML frontmatter 与诊断流程；scripts/ 放排查脚本；references/ 放参考资料。`;

/**
 * 准备这次执行的 system prompt + 把 skill 辅助资源挂到 workspace。
 *
 * SKILL.md 引用 references/ scripts/ templates/ 等辅助文件——单独把 SKILL.md 当 system prompt 注入
 * 是不够的，agent 跑到"加载 references/skill-template.md"那一步会在 workspace 找不到文件。
 * 这里 symlink 一份到 workspace 的 .skill-generator/ 子目录，让 agent 能正常 progressive disclosure。
 *
 * 同时给 system prompt 套一层"meta 指令"：
 *   - 告诉 agent 资源在哪
 *   - 强调要用 write 工具把生成的 skill 文件写到 workspace 根（而不是 .skill-generator/）
 */
function prepareSkillGeneratorSystemPrompt(
  workspaceDir: string,
  user: string,
  threadId: string,
  webSearchEnabled: boolean,
): string {
  const baseSkillContent = fileBasedSkillExists(SKILL_GENERATOR_SKILL_NAME)
    ? loadFileBasedSkillPrompt(SKILL_GENERATOR_SKILL_NAME)
    : SKILL_GENERATOR_FALLBACK_PROMPT;

  const mount = fileBasedSkillExists(SKILL_GENERATOR_SKILL_NAME)
    ? mountFileBasedSkillResources(SKILL_GENERATOR_SKILL_NAME, workspaceDir)
    : { mounted: [] as string[], mountPoint: null };

  // 把已上传的附件清单拼进 prompt——只在真有附件时拼，避免给 agent 死引用空目录。
  // 附件文件在 <workspaceDir>/uploads/ 下，agent 直接用相对路径 read 即可。
  const attachments = listAttachments(user, threadId);
  const attachmentsSection = formatAttachmentsForPrompt(attachments);

  // workspace 当前目录就是 cwd；让 agent 用相对路径
  const meta = [
    '# 运行环境约束',
    '',
    '你的当前工作目录就是 cwd（相对路径直接用即可，不要拼任何前缀如 /workspace/）。',
    '',
    mount.mountPoint
      ? [
          '## SKILL 资源路径——关键约束',
          '',
          `下方 SKILL.md 是**通用 Agent Skills 标准**写法,里面引用的 \`references/xxx\` \`scripts/xxx\` \`templates/xxx\`(裸相对路径)在**本环境部署**里实际位置是 \`./.${SKILL_GENERATOR_SKILL_NAME}/\` 子目录下。`,
          '',
          '**翻译规则——读取时必须套用**:',
          `  - SKILL.md 说 \`references/xxx\`        → 你 read \`./.${SKILL_GENERATOR_SKILL_NAME}/references/xxx\``,
          `  - SKILL.md 说 \`scripts/xxx\`           → 你 read 或 bash \`./.${SKILL_GENERATOR_SKILL_NAME}/scripts/xxx\``,
          `  - SKILL.md 说 \`templates/xxx\`         → 你 read \`./.${SKILL_GENERATOR_SKILL_NAME}/templates/xxx\``,
          '',
          '具体已挂在 mount 里、你可能用到的文件:',
          `  - \`./.${SKILL_GENERATOR_SKILL_NAME}/references/skill-template.md\`(对应 SKILL.md 里的 \`references/skill-template.md\`)`,
          `  - \`./.${SKILL_GENERATOR_SKILL_NAME}/references/scenarios/general.md\`(对应 \`references/scenarios/general.md\`)`,
          `  - \`./.${SKILL_GENERATOR_SKILL_NAME}/references/scenarios/fault-diagnosis.md\`(对应 \`references/scenarios/fault-diagnosis.md\`)`,
          `  - \`./.${SKILL_GENERATOR_SKILL_NAME}/scripts/validate_skill.sh\`(对应 \`scripts/validate_skill.sh\`)`,
          `  - \`./.${SKILL_GENERATOR_SKILL_NAME}/scripts/parse_doc.py\`(对应 \`scripts/parse_doc.py\`)`,
          '',
          '**严禁**:',
          `  - 严禁推理任何绝对路径(如 \`/root/.opencode/skills/\` 或 \`/root/.${SKILL_GENERATOR_SKILL_NAME}/\` 等)——这类路径在本环境不存在,read 会永久卡住。`,
          `  - 严禁去掉 \`./.${SKILL_GENERATOR_SKILL_NAME}/\` 前缀直接 read 裸路径(\`references/skill-template.md\` 等)——workspace 根没这些文件,会卡死。`,
          `  - 严禁写入或修改 \`./.${SKILL_GENERATOR_SKILL_NAME}/\` 目录(只读 mount)。生成的新 skill 文件按下方"写入"规则放 workspace 根,不是 mount 内。`,
        ].join('\n')
      : '',
    '',
    '**最终生成的 skill 必须用 write 工具写到当前工作目录根**：',
    '- ./SKILL.md',
    '- ./scripts/<name>.sh',
    '- ./references/<name>.md',
    '',
    '你的所有任务输出都要落到这些文件里——不要只做计划或描述，要实际调用 write 工具。',
    '',
    // 屏蔽 opencode 自动发现的全局 skill（典型：~/.agents/skills/using-superpowers，
    // description 写着"对话开始必先调我"，会让 agent 浪费一整轮 LLM 调用去 load 它）。
    // 我们这里需要的所有资源已经在 ./.skill-generator/ 下挂好，agent 直接 read 即可。
    '**不要调用 `skill` 工具**——本任务需要的所有资源已经预挂载在 ' +
      `./.${SKILL_GENERATOR_SKILL_NAME}/，直接用 read 工具读取。\`skill\` 工具加载的全局技能（如 ` +
      'using-superpowers / writing-skills 等）在本场景下无关，会浪费上下文。',
    '',
    // 联网搜索开关：用户在对话界面的 toggle 决定本轮是否允许调 web_search / web_fetch。
    // 即使 MCP server 启动时挂着（per-user opencode-server 复用），prompt 层级的禁用
    // 也能让 agent 服从——前面 `不要调用 skill 工具` 是同款套路、已证明 reliable。
    webSearchEnabled
      ? ''
      : '**本轮对话禁止调用 `web_search` 和 `web_fetch` 工具**——用户在 UI 上关闭了联网搜索开关。如果你判断需要查外部资料才能完成任务，请用文字告知用户开关位置（"对话输入框上方的『联网』开关"），不要尝试调用这两个工具。',
    '',
    attachmentsSection,
    '---',
    '',
  ].filter(Boolean).join('\n');

  return meta + baseSkillContent;
}


export interface FileData {
  content: string[];
  created_at: string;
  modified_at: string;
}

/** 从字符串构造 skill-generator 期望的 FileData 形态。Mock 模式与 bridge 共用。 */
export function createFileData(content: string): FileData {
  const now = new Date().toISOString();
  return {
    content: content.split('\n'),
    created_at: now,
    modified_at: now,
  };
}

/**
 * threadId → { opencode sessionId, opencode-server 代次 }
 *
 * 持久化在 PlaygroundSession.opencodeSessionId（slow path），重启时还能恢复。
 * 优先级：内存 cache → DB → 创建新 session。
 *
 * 代次（generation）从 opencode-manager 取。opencode-server 因 configHash 变化重启时
 * 代次 +1；下次取出时如果代次跟当前不一致，说明 sessionId 是旧进程里的、新进程不认，
 * 当作无缓存对待。这弥补了"session.prompt 用失效 sessionId 不报错也不调 LLM"
 * 的静默失败路径——bridge 上一版只在 throw 时 retry，兜不住这种 0-event 静默。
 */
interface CachedOpencodeSession {
  sessionId: string;
  generation: number;
}
const threadSessionMap = new Map<string, CachedOpencodeSession>();

/**
 * threadId 级别的串行化锁。
 * 用户连点"发送"或刷新页面后立刻发新消息时，避免两个并发请求同时操作同一个
 * opencode session 导致状态错乱。新请求会等当前请求结束。
 */
const threadInflight = new Map<string, Promise<unknown>>();

async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadInflight.get(threadId) ?? Promise.resolve();
  // 即便上一个失败也要继续放行下一个，所以 catch 一下
  const next = prev.catch(() => {}).then(fn);
  threadInflight.set(threadId, next);
  try {
    return await next;
  } finally {
    // 只有当我是当前最末尾的那个 promise 时才清，避免后续请求清错
    if (threadInflight.get(threadId) === next) {
      threadInflight.delete(threadId);
    }
  }
}

async function loadCachedOpencodeSessionId(
  threadId: string,
  user: string,
): Promise<string | undefined> {
  const currentGen = getOpencodeServerGeneration(user);
  const fast = threadSessionMap.get(threadId);
  if (fast) {
    if (fast.generation === currentGen) return fast.sessionId;
    // 代次不一致：本进程内重启过 opencode-server，旧 sessionId 已失效
    threadSessionMap.delete(threadId);
    return undefined;
  }
  // DB slow path：dev server 重启后内存清空，回退到 DB 取。注意 DB 里没存代次——
  // 因为 dev server 重启 + opencode-server 启动后代次会从 1 开始，DB 里的 sessionId
  // 是上次进程的，新进程不认。所以从 DB 取出来后**不打代次戳**当作"待验证"使用：
  // 如果它真失效，会被下面的 0-event 兜底逻辑捕获、清掉、重跑。
  try {
    const row = await (prismaRaw as any).skillGeneratorSession.findUnique({
      where: { id: threadId },
      select: { opencodeSessionId: true },
    });
    return row?.opencodeSessionId || undefined;
  } catch {
    // DB 读失败不应阻塞对话——直接走"无缓存"路径起新 session
    return undefined;
  }
}

async function saveOpencodeSessionId(
  threadId: string,
  sessionId: string,
  user: string,
  agentName: string | undefined,
  agentTraceSkill: string | undefined,
): Promise<void> {
  threadSessionMap.set(threadId, {
    sessionId,
    generation: getOpencodeServerGeneration(user),
  });
  try {
    await (prismaRaw as any).skillGeneratorSession.update({
      where: { id: threadId },
      // 同步把 agentName/agentTraceSkill 落库——只是 internal-agent-tag 内存映射的
      // 持久化镜像，让 dev server 重启后再到的 plugin 上报仍能找到正确归属。
      data: {
        opencodeSessionId: sessionId,
        ...(agentName ? { agentName } : {}),
        ...(agentTraceSkill ? { agentTraceSkill } : {}),
      },
    });
  } catch (err) {
    // 写库失败只影响"重启后能否恢复对话/正确归属 trace"，不影响当前对话；记日志即可
    console.warn('[skill-generator-bridge] persist opencodeSessionId failed:', (err as Error)?.message);
  }
}

async function clearOpencodeSessionId(threadId: string): Promise<void> {
  threadSessionMap.delete(threadId);
  try {
    await (prismaRaw as any).skillGeneratorSession.update({
      where: { id: threadId },
      data: { opencodeSessionId: null },
    });
  } catch {
    /* 同上：写库失败不阻塞 */
  }
}

export interface StreamSkillGeneratorOpts {
  user: string;
  threadId: string;
  message: string;
  modelId?: string;
  /** 本轮是否允许 agent 调用 web_search / web_fetch；默认 true（与升级前行为一致） */
  webSearchEnabled?: boolean;
  send: (mode: string, payload: unknown) => void;
}

export interface StreamSkillGeneratorResult {
  agentText: string;
  files: Record<string, FileData>;
}

// Execution trace 不再由 bridge 直接写——改由 ~/.opencode/plugins/Witty-Skill-Insight.ts
// 走 spool → uploader → /api/ingest/upload 链路上报。runner 通过 systemAgentName 在
// internal-agent-tag 注册表里登记标签，upload 路由用标签覆盖 plugin 默认填的字段。
// 好处：所有 trace（用户自跑 + 内部 agent 跑）走统一管道，自动享受 ingest 后续的 skill
// 提取、judge、自动评估订阅等能力。

/**
 * 把用户消息驱动到 opencode，并把整个执行过程翻译成 skill-generator 协议事件。
 * 返回 final agent text 与 final VFS 状态，用于后续落库。
 *
 * 同一 threadId 的并发请求会被自动串行化（避免多个请求同时操作同一 opencode session）。
 */
export function streamSkillGeneratorOpencode(
  opts: StreamSkillGeneratorOpts,
): Promise<StreamSkillGeneratorResult> {
  return withThreadLock(opts.threadId, () => streamSkillGeneratorOpencodeImpl(opts));
}

async function streamSkillGeneratorOpencodeImpl(
  opts: StreamSkillGeneratorOpts,
): Promise<StreamSkillGeneratorResult> {
  const { user, threadId, message, modelId, send } = opts;
  const webSearchEnabled = opts.webSearchEnabled !== false;

  console.log('[skill-generator-bridge] request start', { user, threadId, modelId, messageLen: message.length });

  const modelOverride = await resolveModelOverride(user, modelId);
  console.log('[skill-generator-bridge] modelOverride resolved:', modelOverride
    ? { providerID: modelOverride.providerID, modelID: modelOverride.modelID, baseURL: modelOverride.baseURL, hasApiKey: !!modelOverride.apiKey }
    : null
  );

  // 历史上 bridge 维护过一个 IDLE_BAILOUT_MS（90s/180s）业务事件 watchdog，意图检测
  // "opencode 服务还活着但 agent 卡死"——但 deepseek-reasoner 长思考期（写大文件前
  // 的 silent reasoning，实测可超 3min）从外界看就是这个表象，**误判率 100%**：
  // 每次都把还在正常 stream 的 chat 切掉，agentText 被截到几十字符。
  //
  // 移除该 watchdog，依赖两层兜底：
  //   1) opencode-client 内部 idleTimeoutMs (30s)：heartbeat 来就 reset，
  //      server 真挂 heartbeat 停 30s 后触发——精确捕捉 server 死亡
  //   2) chatOptions.streamTimeoutMs (15min)：死亡上限
  // 如果将来要更精细控制，应该按 step.start/step.finish 而不是按"任意业务事件"。
  const chatAbortController = new AbortController();

  let agentText = '';
  let openThinkingId: string | null = null;
  // thinking 块的累计 fullText（按 thinking block id 索引）——
  // 用于在 reasoning event 重复 emit 时去重，详见 onReasoning。
  const reasoningFullByThinkId = new Map<string, string>();
  const announcedTools = new Set<string>();
  // 累积器：file_edited 时增量更新，每次推完整 state 给前端（前端会 setFiles 全量替换）
  let vfsAccum: Record<string, FileData> = {};
  let workspaceDirRef = '';
  // 本轮是否真改了文件——决定结束时是否发"下载 zip"卡片。
  // 之前的逻辑只看 vfsAccum.size > 0，闲聊回合（workspace 里早就累积了文件）也会
  // 弹卡片，用户重复点开 session 看到一堆下载按钮就懵了。
  let filesChangedThisTurn = false;
  // 用户在本轮 prompt 里明确请求重新打包/下载——即使没改文件也允许补发卡片。
  const userWantsRepack = /重新打包|重新下载|重打包|再打包|再下载|repack|repackage|download\s+again|rebuild\s+package/i.test(message);

  const closeThinkingIfOpen = () => {
    if (openThinkingId) {
      send('thinking', { id: openThinkingId, done: true });
      openThinkingId = null;
    }
  };

  const handlers: ChatHandlers = {
    onText: (e) => {
      closeThinkingIfOpen();
      agentText += e.delta;
      send('text', e.delta);
    },
    onReasoning: (e) => {
      if (!e.delta) return;
      if (!openThinkingId) {
        openThinkingId = `think_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }
      // 用 fullText 做单调递增去重：opencode 同一段 reasoning 可能通过
      //   message.part.delta(field=reasoning) + message.part.updated(type=reasoning) 两条路径
      // 都触发 onReasoning，导致前端 thinking 块被同份内容追加两遍。
      // 跟踪每个 thinking block 累计的 fullText 长度，只在新数据真正"增长"时推 delta。
      const lastFull = reasoningFullByThinkId.get(openThinkingId) ?? '';
      const incomingFull = e.fullText && typeof e.fullText === 'string'
        ? e.fullText
        : lastFull + e.delta;
      if (incomingFull.length <= lastFull.length) {
        // 重复 emit 或回退，跳过
        return;
      }
      const realDelta = incomingFull.startsWith(lastFull)
        ? incomingFull.slice(lastFull.length)
        : e.delta;
      reasoningFullByThinkId.set(openThinkingId, incomingFull);
      send('thinking', { id: openThinkingId, delta: realDelta });
    },
    onTool: (e) => {
      // opencode 的 tool part 经常只有 partID 没有 callID（callID 是 LLM 给的工具调用 id，
      // 不是所有 provider 都有；partID 是 opencode 自己的稳定 part 标识）。
      // 用 callID 优先，没有就降级到 partID——只要前后两次能对得上就行。
      const id = e.callID || e.partID;
      if (!id) return;
      if (e.phase === 'start') {
        if (announcedTools.has(id)) return;
        announcedTools.add(id);
        closeThinkingIfOpen();
        // 注意：start phase 时 opencode 的 part.state.input 通常还是空 {}——LLM 还没把
        // 工具参数编完，要等 tool-call 事件落到 part.state.input 才有完整 input。所以
        // 这里发出去的 args 经常是空，要靠 end phase 的 tool_result 把 finalArgs 补回来。
        send('tool_call', {
          id,
          name: e.name,
          args: e.input,
          status: 'running',
        });
      } else if (e.phase === 'end') {
        // 如果 start 没发出去（极少数情况：start 丢失或 callID/partID 不一致），先补一发
        if (!announcedTools.has(id)) {
          announcedTools.add(id);
          send('tool_call', { id, name: e.name, args: e.input, status: 'running' });
        }
        const summary = stringifyToolOutput(e.output);
        // 路径字段全部改写成 /workspace/<rel> 形态，方便前端 IDE 跳转。
        const finalArgs = sanitizeArgsForUI(e.input, workspaceDirRef);
        // 兜底标记：onFileEdited 在某些 provider 上不一定触发，但 write/edit 工具
        // 成功结束基本等同于"动了文件"——以此补充 filesChangedThisTurn 判定。
        if (
          e.status !== 'error'
          && /^(write|edit|str_replace|edit_file|create_file)$/i.test(e.name || '')
        ) {
          filesChangedThisTurn = true;
        }
        send('tool_result', {
          id,
          status: e.status === 'error' ? 'error' : 'ok',
          summary,
          // **关键**：把最新的 input 一起带过去——start phase 发出的 args 几乎肯定是空 {}，
          // 等 LLM 编完 tool 参数 opencode 在 part.state.input 才有完整数据。前端 tool_result
          // handler 会用这个 finalArgs 覆写 block.args，TodoBlock 的 args.todos 检查、
          // write 工具的 file_path/content、跳转按钮等才能正常工作。
          finalArgs,
        });
      } else if (e.phase === 'error') {
        if (!announcedTools.has(id)) {
          announcedTools.add(id);
          send('tool_call', { id, name: e.name, args: e.input, status: 'running' });
        }
        const finalArgs = sanitizeArgsForUI(e.input, workspaceDirRef);
        send('tool_result', {
          id,
          status: 'error',
          error: stringifyToolOutput((e as any).error) || 'tool error',
          finalArgs,
        });
      }
    },
    onFileEdited: () => {
      // file_edited 不一定每个 write 都触发，且不携带内容；用全量扫描兜底
      filesChangedThisTurn = true;
      if (workspaceDirRef) {
        try {
          vfsAccum = scanWorkspaceFiles(workspaceDirRef);
          send('vfs_patch', { files: vfsAccum });
        } catch {
          /* 扫描出错时忽略，最终 done 前还会扫一次 */
        }
      }
    },
    onAssistantMessage: (e) => {
      // 在助手消息真正终止时收尾。注意区分"本条 message 完成"和"整段对话完成"：
      // 多轮 agent loop（call tool → tool_result → next LLM）里，每一轮都会发一条
      // status=completed 的 assistant message，但 finish=tool-calls 表示马上还有下一轮，
      // 这时 abort 会把后续 reasoning/text 都掐掉（用户症状：调完工具就再无下文）。
      // 仅在 error 或 finish 是终止性 reason（stop/length/content-filter/...）时才 abort。
      if (e.status === 'error') {
        // LLM provider 鉴权失败、超额、网络挂掉这些错误以前会被默默吞掉——
        // assistant message 有 error 但没 parts，bridge 发 'done' 收尾，前端就是空气泡。
        // 这里把错误内容显式推到前端，并把 401（apiKey 无效）翻译成可操作的提示，
        // 不要让用户对着空 UI 猜半天。
        const err = e.info?.error;
        const status = err?.data?.statusCode;
        const upstream = err?.data?.message || err?.message || '模型执行出错';
        let display = upstream;
        if (status === 401 || /authoriz/i.test(String(upstream))) {
          display =
            `模型鉴权失败（401 ${upstream}）。\n` +
            '请到 Settings 页面检查当前激活的 API Key 是否正确/未过期，' +
            '改完后需要重启 dev server 让 opencode 子进程重新读取（或等几秒，' +
            '下一次请求会自动检测 config 变化重启该 user 的实例）。';
        }
        send('error', display);
        setTimeout(() => chatAbortController.abort(), 500);
        return;
      }
      if (e.status === 'completed') {
        const finish = (e.info?.finish ?? e.info?.finishReason) as string | undefined;
        if (finish && finish !== 'tool-calls') {
          setTimeout(() => chatAbortController.abort(), 500);
        }
      }
    },
    onSession: (e) => {
      // session.idle 是 "agent 完全空闲" 信号，作为提前终止依据。
      if (e.phase === 'idle') {
        setTimeout(() => chatAbortController.abort(), 200);
      }
    },
    onQuestion: async (e) => {
      // agent 想问用户一个问题（"ask user" 工具）：
      //  1. 推 SSE 'question' 事件给前端，渲染为答题块
      //  2. 在 pending-requests 里登记一个 awaitable，等用户 POST /api/agent/respond
      //  3. 收到答复 → resolveInteraction → 这里 promise resolve → 返给 opencode
      //  4. 超时 / 用户跳过 / 客户端断连 → 降级返 null（reject）
      // opencode-client 内部的 idleTimer 在 question.asked 时已自动挂起（见
      // opencode-client.ts case "question.asked"），用户思考再久也不会被切。
      const id = e.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const questionText = formatQuestionText(e.questions);
      send('question', {
        id,
        question: questionText,
        choices: e.questions,
      });
      try {
        // 5 分钟内用户不答复就降级 reject。awaitInteraction 自带 TTL，超时抛错被下面 catch 接住。
        const reply = await awaitInteraction({
          requestId: id,
          kind: 'question',
          user,
          streamId: threadId,           // 用 threadId 作为 stream 维度，便于后续断连批量取消
          ttlMs: 5 * 60_000,
        });
        // reply 可能是数组（answers）或 null（用户主动跳过）
        send('question_answered', {
          id,
          status: reply == null ? 'skipped' : 'answered',
          answer: reply == null ? undefined : (Array.isArray(reply) ? reply.join('\n') : String(reply)),
        });
        return reply ?? null;
      } catch (err) {
        // 超时 / 取消 → 通知前端，agent 那边 reject
        send('question_answered', {
          id,
          status: 'skipped',
          answer: '(超时未回答，已自动跳过)',
        });
        return null;
      }
    },
  };

  const cachedSessionId = await loadCachedOpencodeSessionId(threadId, user);
  console.log('[skill-generator-bridge] cachedSessionId:', cachedSessionId || '(none)');

  // 提前解析 workspaceDir：prepareSkillGeneratorSystemPrompt 需要把 SKILL 资源 mount 进去。
  // runner 内部也会 ensureSessionWorkspace 一次（同一路径，幂等）。
  ensureUserWorkspace(user);
  const workspaceDir = ensureSessionWorkspace(user, threadId);
  console.log('[skill-generator-bridge] workspaceDir:', workspaceDir);
  const skillGeneratorSystemPrompt = prepareSkillGeneratorSystemPrompt(workspaceDir, user, threadId, webSearchEnabled);
  // 立刻填上 workspaceDirRef——onTool 在 chat() 中需要用它把 write 工具的绝对路径
  // 转成前端 IDE 能识别的 /workspace/<rel> VFS 形态（跳转按钮才点得到对应文件）。
  // 之前只在 chat() 返回后赋值（line 577 附近的 result.workspaceDir），onTool 期间永远是空。
  workspaceDirRef = workspaceDir;

  let result;
  try {
    console.log('[skill-generator-bridge] calling runGeneralAgent...');
    result = await runGeneralAgent({
      user,
      query: message,
      sessionId: cachedSessionId,
      // 关键：用 threadId 锁定稳定的 workspace 目录，让多轮对话共享同一份文件
      workspaceTag: threadId,
      sessionTitle: `skill-generator · ${threadId.slice(0, 12)}`,
      system: skillGeneratorSystemPrompt,
      // chat 流空闲超过 30s 自动结束。skill-generator 场景下 agent 写完文件 + 说完话就该收尾，
      // opencode 偶发的"残留 keepalive 事件"会让默认 60s idle 一直触发不到，前端干等 240s+。
      chatOptions: {
        idleTimeoutMs: 30_000,
        // R1 这种 thinking 模型 + 多轮 LLM 调用（agent 加载多个 skill 后写文件）容易超 5min；
        // 实际 close 由 opencode-client 内部 idleTimer (30s, heartbeat reset) +
        // onAssistantMessage(completed) + onSession(idle) 控制，streamTimeout 是死亡兜底。
        streamTimeoutMs: 15 * 60 * 1000,
        signal: chatAbortController.signal,
      },
      // 内部 agent 标签：让 plugin 上报的 trace 在 /api/ingest/upload 那边能正确归属。
      // skill 标签由 SYSTEM_AGENTS 中该 Agent 的 traceSkill 字段提供，这里不传 skill 字段
      // （传了会触发 runner 的 DB skill 加载，与文件式 system prompt 冲突）。
      systemAgentName: SKILL_GENERATOR_AGENT_NAME,
      interactionPolicy: 'auto-allow',
      ...(modelOverride ? { model: modelOverride } : {}),
      handlers,
    });
  } catch (err) {
    // 复用的 session 可能在 opencode 端失效（server 重启 / 主动 abort），换一个 session 重跑一次
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[skill-generator-bridge] runGeneralAgent threw:', msg);
    if (cachedSessionId && /session/i.test(msg)) {
      console.log('[skill-generator-bridge] retrying without cachedSessionId...');
      await clearOpencodeSessionId(threadId);
      result = await runGeneralAgent({
        user,
        query: message,
        workspaceTag: threadId,
        sessionTitle: `skill-generator · ${threadId.slice(0, 12)}`,
        system: skillGeneratorSystemPrompt,
        interactionPolicy: 'auto-allow',
        ...(modelOverride ? { model: modelOverride } : {}),
        handlers,
      });
    } else {
      throw err;
    }
  }

  // 静默失败兜底：opencode-server 因 configHash 变化（如本期加了 MCP）被重启后，
  // 内存里的 session 全没了；用旧 sessionId 调 session.prompt **不报错也不调 LLM**——
  // 只收到一个 'server.connected' 事件就回 200。前端表现：转圈圈、最后空气泡。
  //
  // 上面的 catch 只覆盖 throw 路径。这里补一刀：用了 cachedSessionId 但本轮一个 LLM
  // 事件都没出来（textDelta + toolCall 全 0），认定 session 失效，清掉 cache 重跑。
  if (
    cachedSessionId
    && result.stats
    && result.stats.textDeltaCount === 0
    && result.stats.toolCallCount === 0
  ) {
    console.warn(
      '[skill-generator-bridge] stale session detected (0 LLM events with cachedSessionId), retrying fresh',
    );
    await clearOpencodeSessionId(threadId);
    // 把 handlers 里累积的状态重置——不然第二轮会跟第一轮的"空"叠在一起。
    agentText = '';
    openThinkingId = null;
    reasoningFullByThinkId.clear();
    announcedTools.clear();
    vfsAccum = {};
    filesChangedThisTurn = false;
    result = await runGeneralAgent({
      user,
      query: message,
      workspaceTag: threadId,
      sessionTitle: `skill-generator · ${threadId.slice(0, 12)}`,
      system: skillGeneratorSystemPrompt,
      systemAgentName: SKILL_GENERATOR_AGENT_NAME,
      interactionPolicy: 'auto-allow',
      chatOptions: {
        idleTimeoutMs: 30_000,
        streamTimeoutMs: 15 * 60 * 1000,
        signal: chatAbortController.signal,
      },
      ...(modelOverride ? { model: modelOverride } : {}),
      handlers,
    });
  }

  // 合并解决：保留同事加的 runGeneralAgent done 调试日志（方便排查 agent 跑完但
  // 前端看不到 reply 的情况）+ 用 4 参数版 saveOpencodeSessionId 把 agentName/skill 一并落库。
  console.log('[skill-generator-bridge] runGeneralAgent done:', {
    sessionId: result.sessionId,
    workspaceDir: result.workspaceDir,
    outputLen: result.output.length,
    agentTextLen: agentText.length,
    stats: result.stats,
    interactions: result.interactions.length,
  });

  // 末端兜底：opencode session.prompt 偶尔会返回 HTTP body 里带完整回复文本、
  // 但缺 info.id/message.id 字段——client 的 fallback emit 因此无法触发
  // (assistantMsgId && 这一守卫)。结果 SSE 上一个 text delta 都没出，agentText
  // 空、用户看到空气泡，但 result.output 里实际上有内容。
  //
  // 这里如果检测到 onText 一次没被调过但 result.output 非空，把整段 output
  // 当一次 text 发出去——既不重复（agentText 空时才发）、又不会丢内容。
  if (!agentText && result.output && result.output.trim()) {
    closeThinkingIfOpen();
    agentText = result.output;
    send('text', result.output);
  }

  await saveOpencodeSessionId(
    threadId,
    result.sessionId,
    user,
    SKILL_GENERATOR_AGENT_NAME,
    SKILL_GENERATOR_SKILL_NAME,
  );

  closeThinkingIfOpen();

  // 兜底全量扫描，作为最终一份 VFS 状态
  workspaceDirRef = result.workspaceDir;
  vfsAccum = scanWorkspaceFiles(result.workspaceDir);
  console.log('[skill-generator-bridge] workspace files:', Object.keys(vfsAccum));
  send('vfs_patch', { files: vfsAccum });

  // download 卡片：只在"本轮真有文件改动"或用户明确"重新打包"时弹。
  // 之前无条件发，导致后续每次闲聊（agent 没碰任何文件）都会弹一张下载卡，
  // 用户在 session 历史里能看到一长串重复卡片。
  const hasFiles = Object.keys(vfsAccum).length > 0;
  if (hasFiles && (filesChangedThisTurn || userWantsRepack)) {
    const { skillName, fileCount, sizeBytes } = summarizeSkillBundle(vfsAccum);
    send('download', { id: `dl_${Date.now()}`, skillName, fileCount, sizeBytes });
  }

  send('done', { reason: 'completed' });

  // Trace 由 plugin 异步上报；bridge 不再直接写 Execution。
  return { agentText, files: vfsAccum };
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

async function resolveModelOverride(
  user: string,
  modelId?: string,
): Promise<OpencodeModelConfig | null> {
  if (!modelId) {
    console.log('[skill-generator-bridge] resolveModelOverride: no modelId, skip');
    return null;
  }
  const settings = await getUserSettings(user);
  const allIds = settings.configs.map((c) => c.id);
  console.log('[skill-generator-bridge] resolveModelOverride: looking for', modelId, 'in configs:', allIds);
  const cfg: ServerModelConfig | undefined = settings.configs.find((c) => c.id === modelId);
  if (!cfg) {
    console.warn('[skill-generator-bridge] resolveModelOverride: config not found, falling back to default model');
    return null;
  }
  if (!cfg.apiKey) {
    console.warn('[skill-generator-bridge] resolveModelOverride: config found but apiKey missing, falling back to default model');
    return null;
  }
  const explicitProvider = (cfg as { provider?: string }).provider;
  const providerID = normalizeProviderID(explicitProvider || inferProviderFromBaseUrl(cfg.baseUrl));
  const result = {
    providerID,
    modelID: cfg.model || 'deepseek-chat',
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  };
  console.log('[skill-generator-bridge] resolveModelOverride: resolved to', { providerID: result.providerID, modelID: result.modelID, baseURL: result.baseURL });
  return result;
}

/**
 * opencode question 事件的 questions 字段结构在不同模型/工具下不太一致：
 *   - string: "Are you sure?"
 *   - array of strings: ["yes", "no"]
 *   - array of objects: [{question: "...", choices: [...]}]
 *   - {prompt, choices, type}
 * 这里尽量平铺成一段可读文本，前端就能直接展示。
 */
function formatQuestionText(questions: unknown): string {
  if (typeof questions === 'string') return questions;
  if (!Array.isArray(questions)) {
    if (questions && typeof questions === 'object') {
      const obj = questions as Record<string, unknown>;
      const prompt = obj.prompt || obj.question || obj.text;
      if (typeof prompt === 'string') return prompt;
    }
    return JSON.stringify(questions ?? {});
  }
  return questions
    .map((q) => {
      if (typeof q === 'string') return q;
      if (q && typeof q === 'object') {
        const obj = q as Record<string, unknown>;
        const prompt = obj.prompt || obj.question || obj.text;
        if (typeof prompt === 'string') return prompt;
      }
      return JSON.stringify(q);
    })
    .join('\n');
}

// 工具输出截断上限：4 KB。之前 200 太紧，bash/read 这种实质内容立刻被砍光，前端只能
// 看见 "Wrote file successfully." / "(no output)" 这种几个字摘要。4 KB 能放下绝大多数
// validate 脚本输出 / read 文件首屏 / 错误堆栈，又不至于把超长 read 的整段文件塞进
// SSE 流。前端真要看完整的，去 IDE 面板里打开文件即可。
const TOOL_OUTPUT_MAX_CHARS = 4000;

/**
 * opencode 工具参数里的 file path 字段都是 workspace 绝对路径
 *   /Users/.../agent_workspaces/<user-slug>/<threadId>/travel-guide/SKILL.md
 * 这种形态前端 IDE 面板用 `/workspace/<rel>` 当 key 索引（见 scanWorkspaceFiles 的
 * VFS_PREFIX 用法）。点跳转按钮 onOpenFile(path) 收到绝对路径会找不到——查 files
 * 字典查不到 key、文件树高亮也对不上。
 *
 * 这里把 args 里所有形似"文件路径"的字段（filePath / file_path / path / filename）
 * 在 workspaceDir 范围内的值改写成 /workspace/<rel> 形态，让前端跳转直接命中。
 * 不在 workspaceDir 范围（外部资源、绝对路径如 /etc/...）保持原样。
 */
const PATH_LIKE_KEYS = new Set(['filePath', 'file_path', 'path', 'filename', 'file']);
function toVfsPathIfWithin(absPath: string, workspaceDir: string): string {
  if (!workspaceDir || typeof absPath !== 'string') return absPath;
  if (absPath === workspaceDir) return '/workspace';
  if (absPath.startsWith(workspaceDir + '/')) {
    return '/workspace/' + absPath.slice(workspaceDir.length + 1);
  }
  return absPath;
}
function sanitizeArgsForUI(input: unknown, workspaceDir: string): unknown {
  if (!input || typeof input !== 'object' || workspaceDir === '') return input;
  // shallow copy + 只重写第一层 path-like 字段。深度递归没必要——opencode tool input
  // 都是单层结构（todowrite 的 todos 数组没有 path 字段）。
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (PATH_LIKE_KEYS.has(k) && typeof out[k] === 'string') {
      out[k] = toVfsPathIfWithin(out[k] as string, workspaceDir);
    }
  }
  return out;
}

function truncateForUI(s: string): string {
  if (s.length <= TOOL_OUTPUT_MAX_CHARS) return s;
  return s.slice(0, TOOL_OUTPUT_MAX_CHARS) + `\n\n…[已截断，剩余 ${s.length - TOOL_OUTPUT_MAX_CHARS} 字符省略]`;
}

function stringifyToolOutput(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return truncateForUI(output);
  try {
    return truncateForUI(JSON.stringify(output, null, 2));
  } catch {
    return truncateForUI(String(output));
  }
}

const VFS_PREFIX = '/workspace/';
const VFS_FILE_SIZE_CAP = 1024 * 1024; // 1MB
const VFS_IGNORE = new Set([
  'node_modules',
  '.git',
  '.opencode',
  '.DS_Store',
  // 用户上传的素材——由附件 API 独立管理，不进生成产物视图也不进下载 zip
  UPLOADS_DIR,
]);

/**
 * 扫描 opencode 真实工作目录，转成 skill-generator 期望的 /workspace/<rel> VFS 形态。
 * 跳过隐藏目录、超大文件、读不出的二进制文件。
 */
export function scanWorkspaceFiles(workspaceDir: string): Record<string, FileData> {
  const result: Record<string, FileData> = {};
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return result;

  const walk = (dir: string) => {
    let items: string[];
    try {
      items = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (VFS_IGNORE.has(item)) continue;
      if (item.startsWith('.')) continue;
      const fullPath = path.join(dir, item);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (stat.size > VFS_FILE_SIZE_CAP) continue;
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
      // utf-8 读到 NUL 字节多半是二进制，跳过
      if (content.includes(' ')) continue;
      const rel = path.relative(workspaceDir, fullPath).replace(/\\/g, '/');
      const vfsPath = `${VFS_PREFIX}${rel}`;
      result[vfsPath] = {
        content: content.split('\n'),
        created_at: stat.birthtime.toISOString(),
        modified_at: stat.mtime.toISOString(),
      };
    }
  };
  walk(workspaceDir);
  return result;
}

function summarizeSkillBundle(files: Record<string, FileData>): {
  skillName: string;
  fileCount: number;
  sizeBytes: number;
} {
  let skillName = 'skill';
  const skillMd = files[`${VFS_PREFIX}SKILL.md`];
  if (skillMd) {
    const text = skillMd.content.join('\n');
    const m = text.match(/^name:\s*(.+)$/m);
    if (m) skillName = m[1].trim();
  }
  const fileCount = Object.keys(files).length;
  const sizeBytes = Object.values(files).reduce((acc, fd) => acc + fd.content.join('\n').length, 0);
  return { skillName, fileCount, sizeBytes };
}
