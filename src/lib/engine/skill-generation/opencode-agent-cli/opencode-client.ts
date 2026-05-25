/**
 * opencode-client.ts
 * --------------------------------------------------------------------------
 * 基于 @opencode-ai/sdk 的 opencode 服务封装客户端。
 *
 * 设计目标（相对原版的核心改进）:
 *   1. 完整流式事件透传：在 chat() 中以"统一信封 + 类型化回调 + 原始事件"
 *      三层方式向上层暴露所有 opencode 事件，绝不吞事件。
 *   2. 用户/助手消息分离：用户提问（user message）也被作为 message 事件
 *      上抛，便于上层日志/审计/重放。
 *   3. 工具调用全生命周期追踪：根据 state.status (pending → running →
 *      completed/error) 区分 tool_start / tool_delta / tool_end，避免
 *      上层只能看到最终结果。
 *   4. 推理（reasoning / thinking）流式透传：与文本输出分离的独立增量流。
 *   5. Subagent 全程跟踪：通过 session.created (parentID 链路) 与
 *      part.type === "agent" / "subtask" 的组合，自动加入 allowedSessionIDs，
 *      并把子 session 的所有事件以 subagent.* 命名空间转发，解决官方
 *      issue #6573 中 subagent 事件被过滤掉的问题。
 *   6. step.* 与 token/cost 用量分离：step-start/step-finish 单独通道。
 *   7. 提示词请求并发安全：先建立 SSE 订阅，再 sendPrompt，避免漏掉
 *      首批 message.part.updated 事件。
 *   8. 中断与超时：AbortSignal、整体 streamTimeoutMs、空闲心跳超时三层。
 *
 * 依赖:
 *   npm install @opencode-ai/sdk
 *
 * 服务端:
 *   opencode serve --port 4096 --hostname 127.0.0.1
 * --------------------------------------------------------------------------
 */

// @ts-ignore
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { fileURLToPath } from "node:url";

// =============================================================================
// 类型定义
// =============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error" | "off";

export interface AgentInsightOptions {
  baseURL: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
  /** 仅用于日志展示，新版 SDK 不直接暴露请求超时设置。 */
  timeout?: number;
  /** 仅用于日志展示。 */
  maxRetries?: number;
  logLevel?: LogLevel;
  directory?: string;
}

export interface ModelConfig {
  providerID: string;
  modelID: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface SendPromptPayload {
  text: string;
  agent?: string;
  model: ModelConfig;
  modelOptions?: Record<string, unknown>;
  system?: string;
  permission?: unknown[];
  directory?: string;
  /** 强制只插入 user message 不触发 AI 响应。 */
  noReply?: boolean;
  /** 结构化输出 schema，对应 SDK 的 format / outputFormat 字段。 */
  format?: { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };
  /** 透传到 prompt body 的额外字段，如 messageID 等。 */
  [key: string]: unknown;
}

/** opencode 事件统一信封。 */
export interface EventEnvelope {
  type: string;
  properties?: Record<string, any>;
}

// ---------------------------- 业务化事件子类型 -------------------------------

export interface UserMessageEvent {
  sessionID: string;
  messageID: string;
  text: string;
  parts: any[];
  raw: any;
}

export interface AssistantMessageEvent {
  sessionID: string;
  messageID: string;
  status: "started" | "updated" | "completed" | "error";
  info: any;
  error?: { name?: string; message?: string; [k: string]: unknown };
}

export interface TextDeltaEvent {
  sessionID: string;
  messageID: string;
  partID: string;
  delta: string;
  fullText: string;
}

export interface ReasoningDeltaEvent {
  sessionID: string;
  messageID: string;
  partID: string;
  delta: string;
  fullText: string;
}

export type ToolPhase = "start" | "delta" | "end" | "error";

export interface ToolCallEvent {
  phase: ToolPhase;
  sessionID: string;
  messageID?: string;
  partID?: string;
  callID?: string;
  name: string;
  status?: string; // pending | running | completed | error
  input?: unknown;
  output?: unknown;
  error?: unknown;
  /** 嵌套子会话 id（task/subagent 工具会有）。 */
  taskSessionID?: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentEvent {
  /** dispatched: 工具发起；session_created: 子 session 建立；text/tool/done: 子会话内事件。 */
  phase: "dispatched" | "session_created" | "text" | "tool" | "reasoning" | "step" | "idle" | "error" | "done";
  parentSessionID: string;
  sessionID?: string;
  agent?: string;
  description?: string;
  prompt?: string;
  /** 当 phase 为 text/reasoning 时 */
  textDelta?: string;
  /** 当 phase 为 tool 时 */
  tool?: ToolCallEvent;
  /** 当 phase 为 error 时 */
  error?: unknown;
  raw?: EventEnvelope;
}

export interface StepEvent {
  phase: "start" | "finish";
  sessionID: string;
  messageID?: string;
  partID?: string;
  reason?: string;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: unknown };
  cost?: number;
}

export interface PermissionAskEvent {
  id: string;
  sessionID: string;
  messageID?: string;
  callID?: string;
  title?: string;
  type?: string;
  pattern?: string;
  metadata?: unknown;
}

export interface QuestionAskEvent {
  id: string;
  sessionID: string;
  messageID?: string;
  questions?: any[];
}

export interface TodoUpdatedEvent {
  sessionID: string;
  todos: any[];
}

export interface SessionLifecycleEvent {
  phase:
    | "created"
    | "updated"
    | "deleted"
    | "compacted"
    | "diff"
    | "idle"
    | "error"
    | "status";
  sessionID: string;
  info?: any;
  status?: any;
  error?: any;
  raw?: EventEnvelope;
}

export interface FileEditedEvent {
  sessionID?: string;
  path?: string;
  raw?: EventEnvelope;
}

export interface ChatHandlers {
  // ---- 高层语义事件 ----
  onUserMessage?: (e: UserMessageEvent) => void;
  onAssistantMessage?: (e: AssistantMessageEvent) => void;
  onText?: (e: TextDeltaEvent) => void;
  onReasoning?: (e: ReasoningDeltaEvent) => void;
  onTool?: (e: ToolCallEvent) => void;
  onStep?: (e: StepEvent) => void;
  onSubagent?: (e: SubagentEvent) => void;
  onTodo?: (e: TodoUpdatedEvent) => void;
  onSession?: (e: SessionLifecycleEvent) => void;
  /** 兼容旧调用方：等价于 onStep({ phase: "finish" }). */
  onStepFinish?: (e: StepEvent) => void;
  /** 兼容旧调用方：等价于 onSession({ phase: "status" }). */
  onSessionStatus?: (e: SessionLifecycleEvent) => void;
  /** 兼容旧调用方：等价于 onSession({ phase: "idle" }). */
  onSessionIdle?: (e: SessionLifecycleEvent) => void;
  /** 兼容旧调用方：等价于 onSession({ phase: "error" }). */
  onSessionError?: (e: SessionLifecycleEvent) => void;
  onFileEdited?: (e: FileEditedEvent) => void;
  onPermission?: (
    e: PermissionAskEvent,
  ) => Promise<"once" | "always" | "reject"> | "once" | "always" | "reject";
  onQuestion?: (
    e: QuestionAskEvent,
  ) => any[] | null | Promise<any[] | null>;

  // ---- 底层钩子 ----
  /** 任何事件流过时的最原始回调，便于审计/调试。 */
  onRawEvent?: (event: EventEnvelope) => void;
  /** 命中 switch default 分支的事件。 */
  onUnhandledEvent?: (event: EventEnvelope) => void;
  /** chat 出错。 */
  onError?: (err: Error) => void;
  /** chat 完成（无论成功失败都会调用）。 */
  onDone?: () => void;
}

export interface ChatOptions {
  /** SSE 订阅最长时间（ms），默认 5 分钟。 */
  streamTimeoutMs?: number;
  /** 多久没收到任何事件就强制结束（ms），0 表示不启用。默认 0。 */
  idleTimeoutMs?: number;
  /** 外部中断信号。 */
  signal?: AbortSignal;
}

// =============================================================================
// 工具函数
// =============================================================================

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 50,
};

function assertNonEmptyString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} 不能为空`);
  }
}

function buildBasicAuthHeader(username = "opencode", password?: string): string | null {
  if (!password) return null;
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${token}`;
}

function normalizeBaseURL(baseURL: string): string {
  assertNonEmptyString(baseURL, "baseURL");
  return baseURL.replace(/\/+$/, "");
}

/** 兼容 SDK 不同字段命名（sessionID/sessionId）的取值器。 */
function getSessionID(event: EventEnvelope): string | undefined {
  const p = event?.properties || {};
  return (
    p.sessionID ||
    p.sessionId ||
    p.info?.sessionID ||
    p.info?.sessionId ||
    p.part?.sessionID ||
    p.part?.sessionId
  );
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "name" in err &&
      ((err as { name: string }).name === "AbortError" ||
        (err as { name: string }).name === "DOMException"),
  );
}

function unwrapData<T>(result: unknown): T {
  if (
    result &&
    typeof result === "object" &&
    "data" in (result as Record<string, unknown>)
  ) {
    return (result as { data: T }).data;
  }
  return result as T;
}

function extractTextFromParts(parts: any[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (p && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join("");
}

function extractTextFromPromptResponse(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const r = response as Record<string, any>;
  return extractTextFromParts(Array.isArray(r.parts) ? r.parts : []);
}

async function tryGetChildSessionIDs(
  client: OpencodeClient,
  sessionId: string,
): Promise<string[]> {
  try {
    const result = await client.session.children({ path: { id: sessionId } });
    const data = unwrapData<any[]>(result);
    if (!Array.isArray(data)) return [];
    return data.map((s) => String(s?.id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

// =============================================================================
// AgentInsight 客户端
// =============================================================================

export class AgentInsight {
  private readonly client: OpencodeClient;
  private readonly defaultDirectory?: string;
  private readonly logLevel: LogLevel;
  /** 保存 baseURL 是为了 raw fetch /question/{id}/reply——v1 SDK 的 OpencodeClient
   *  没有 question 命名空间（只有 v2 SDK 才有），不能走 client 方法，得自己拼 URL。*/
  private readonly baseURL: string;
  /** 同上 raw fetch 用：把构造时的 auth header / 用户自定义 header 一起带上。*/
  private readonly rawFetchHeaders: Record<string, string>;

  constructor({
    baseURL,
    username,
    password,
    headers = {},
    timeout = 120_000,
    maxRetries = 2,
    logLevel = "warn",
    directory,
  }: AgentInsightOptions) {
    const auth = buildBasicAuthHeader(username, password);
    const finalHeaders: Record<string, string> = {
      ...headers,
      ...(auth ? { Authorization: auth } : {}),
    };

    this.logLevel = logLevel;
    this.defaultDirectory = directory;
    this.baseURL = normalizeBaseURL(baseURL);
    this.rawFetchHeaders = finalHeaders;
    this.client = createOpencodeClient({
      baseUrl: this.baseURL,
      headers: finalHeaders,
      throwOnError: true,
      responseStyle: "data",
    });

    this.log("info", "initialized", {
      baseURL: normalizeBaseURL(baseURL),
      hasAuth: Boolean(auth),
      hasDefaultDirectory: Boolean(directory),
      timeout,
      maxRetries,
      logLevel,
    });
  }

  // --------------------------- 提问应答 (raw fetch) ---------------------------

  /**
   * 把 user 的 question 应答送回 opencode-server。
   *
   * 为啥不走 client：v1 SDK 的 OpencodeClient 类不暴露 question 命名空间
   * （permission 走 /session/{id}/permissions/{permissionID} 是 session-scoped；
   * question 走全局 /question/{id}/reply，v1 SDK 漏了，只有 v2 SDK 有）。
   * 之前用 (this.client as any).question?.reply optional chain 走，生产环境永远是
   * undefined，optional chain 默默吞掉——bridge.onQuestion 拿到 reply 但永远没传给
   * opencode，agent 的 question 工具一直在等响应，前端就一直转圈。这里直接 raw fetch。
   */
  private async respondQuestion(
    requestID: string,
    answers: any[] | null,
  ): Promise<void> {
    if (!requestID) return;
    const isReply = Array.isArray(answers) && answers.length > 0;
    const path = isReply
      ? `/question/${encodeURIComponent(requestID)}/reply`
      : `/question/${encodeURIComponent(requestID)}/reject`;
    // directory 是 query 参数（v2 SDK schema），有就带上，让 server 能定位 workspace。
    const url = this.defaultDirectory
      ? `${this.baseURL}${path}?directory=${encodeURIComponent(this.defaultDirectory)}`
      : `${this.baseURL}${path}`;

    // opencode 的 reply schema 是 **array-of-arrays**：
    //   { answers: Array<Array<string>> }
    // 每个外层元素对应 question.questions 数组里的一个问题，每个内层数组是该问题的
    // 选中标签（多选）。见 exclude/opencode/.../question/index.ts:50-57。
    //
    // 我们 bridge 现在只暴露单问题模型——前端 (page.tsx:1366) 提交的 reply 是 [string]
    // 形态（一个问题 → 一个标签），所以到这里 answers 是 string[]。要按 opencode schema
    // 再外包一层变成 [[string]]。如果将来 caller 已经传成 array-of-arrays（多问题或
    // 多选），就保持原样不再嵌套。
    let body = "{}";
    if (isReply) {
      const alreadyNested = Array.isArray(answers[0]);
      const wrapped = alreadyNested ? answers : [answers];
      body = JSON.stringify({ answers: wrapped });
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.rawFetchHeaders,
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("error", "chat.question.reply.http_failed", {
          requestID,
          status: res.status,
          body: text.slice(0, 300),
        });
      }
    } catch (err) {
      this.log("error", "chat.question.reply.fetch_failed", {
        requestID,
        error: (err as Error)?.message,
      });
    }
  }

  /**
   * 把 user 的 permission 应答送回 opencode-server。
   *
   * 同 respondQuestion 一样：v1 SDK 的 OpencodeClient 类**没有 `permission` 命名空间**
   * （只有 verbose 命名 `postSessionIdPermissionsPermissionId` 单独挂在类身上，没归到
   * 子对象下），原代码 `(this.client as any).permission?.reply` 永远是 undefined，
   * optional chain 默默吞掉。后果：read/edit/bash 等需要权限的工具调一律卡死，
   * agent 在 permission.asked 上等响应等到 watchdog 超时——前端表现就是工具调用一直转圈。
   *
   * 走 session-scoped 路径 `/session/{sessionID}/permissions/{permissionID}`——v1 SDK
   * 类型 (gen/types.gen.d.ts:2507) 明确定义了 body schema 是 `{ response: 'once' |
   * 'always' | 'reject' }`，跟 v2 全局路径 `/permission/{id}/reply` body 字段名 `reply`
   * 不一样，注意别搞混。
   */
  private async respondPermission(
    sessionID: string,
    permissionID: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    if (!sessionID || !permissionID) return;
    const path = `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`;
    const url = this.defaultDirectory
      ? `${this.baseURL}${path}?directory=${encodeURIComponent(this.defaultDirectory)}`
      : `${this.baseURL}${path}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.rawFetchHeaders,
        },
        body: JSON.stringify({ response }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log("error", "chat.permission.reply.http_failed", {
          sessionID,
          permissionID,
          status: res.status,
          body: text.slice(0, 300),
        });
      }
    } catch (err) {
      this.log("error", "chat.permission.reply.fetch_failed", {
        sessionID,
        permissionID,
        error: (err as Error)?.message,
      });
    }
  }

  // --------------------------- 日志 ---------------------------

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.logLevel];
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;
    const ts = new Date().toISOString();
    const prefix = `[AgentInsight][${level.toUpperCase()}][${ts}] ${message}`;
    const writer =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "info"
            ? console.info
            : console.debug;
    if (data) writer(prefix, data);
    else writer(prefix);
  }

  // --------------------------- Session ---------------------------

  async listSessions() {
    const result = await this.client.session.list({
      query: this.defaultDirectory ? { directory: this.defaultDirectory } : undefined,
    });
    return unwrapData<any[]>(result);
  }

  async createSession({ title, parentID, permission, directory }: { title?: string; parentID?: string; permission?: any[]; directory?: string } = {}) {
    // 优先用 caller 显式传的 directory; 没传才退到 client 级默认。
    // 显式传 directory 是为了 per-session workspace 隔离: skill 生成 / 评测每次任务在
    // ~/.agent_insight/agent_workspaces/<user>/<sessionTag>/ 起独立目录,session.cwd
    // 必须锁到这里,否则 agent 把相对路径(如 SKILL.md 写的 "references/skill-template.md")
    // 解析到 opencode spawn 时的 cwd(往往是 /root),read 不存在的文件,opencode 1.14.x
    // 的 read tool 又不抛 ENOENT 而是 hang 在 running -> 工具调用永久卡死。
    const sessionDirectory = directory || this.defaultDirectory;
    const result = await this.client.session.create({
      query: sessionDirectory ? { directory: sessionDirectory } : undefined,
      body: {
        title: title || `opencode-session-${Date.now()}`,
        ...(parentID ? { parentID } : {}),
        ...(permission ? { permission } : {}),
      }
    });
    return unwrapData<Record<string, unknown>>(result);
  }

  async getSession(sessionId: string) {
    assertNonEmptyString(sessionId, "sessionId");
    return unwrapData<Record<string, unknown>>(
      await this.client.session.get({
        path: { id: sessionId },
        query: this.defaultDirectory ? { directory: this.defaultDirectory } : undefined,
      }),
    );
  }

  async deleteSession(sessionId: string) {
    assertNonEmptyString(sessionId, "sessionId");
    return unwrapData<boolean>(
      await this.client.session.delete({
        path: { id: sessionId },
        query: this.defaultDirectory ? { directory: this.defaultDirectory } : undefined,
      }),
    );
  }

  async abortSession(sessionId: string) {
    assertNonEmptyString(sessionId, "sessionId");
    return unwrapData<boolean>(
      await this.client.session.abort({ path: { id: sessionId } }),
    );
  }

  async listMessages(sessionId: string) {
    assertNonEmptyString(sessionId, "sessionId");
    return unwrapData<any[]>(
      await this.client.session.messages({ path: { id: sessionId } }),
    );
  }

  // --------------------------- Prompt ---------------------------

  async sendPrompt(
    sessionId: string,
    payload: SendPromptPayload,
    options: { signal?: AbortSignal } = {},
  ) {
    assertNonEmptyString(sessionId, "sessionId");
    assertNonEmptyString(payload?.text, "text");
    assertNonEmptyString(payload?.model?.providerID, "model.providerID");
    assertNonEmptyString(payload?.model?.modelID, "model.modelID");

    const {
      text,
      agent,
      model,
      modelOptions,
      system,
      permission,
      directory,
      noReply,
      format,
      ...rest
    } = payload;

    const resolvedAgent =
      typeof agent === "string" && agent.trim() ? agent.trim() : "build";

    const { providerID, modelID, apiKey, baseURL, headers, ...modelExtras } = model;

    const providerOptions: Record<string, unknown> = {};
    if (apiKey || baseURL || headers || Object.keys(modelExtras).length > 0) {
      providerOptions[providerID] = {
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(headers ? { headers } : {}),
        ...modelExtras,
      };
    }

    const body: Record<string, unknown> = {
      agent: resolvedAgent,
      model: { providerID, modelID },
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      ...(modelOptions ? { modelOptions } : {}),
      parts: [{ type: "text" as const, text }],
      ...(system ? { system } : {}),
      ...(permission ? { permission } : {}),
      ...(directory ? { directory } : {}),
      ...(noReply ? { noReply: true } : {}),
      ...(format ? { format } : {}),
      ...rest,
    };

    this.log("debug", "sendPrompt.request", {
      sessionId,
      agent: resolvedAgent,
      providerID,
      modelID,
      textLength: text.length,
      hasSystem: Boolean(system),
      hasPermission: Array.isArray(permission) && permission.length > 0,
      directory: directory || this.defaultDirectory || null,
      hasFormat: Boolean(format),
    });

    const result = await this.client.session.prompt({
      path: { id: sessionId },
      query: directory
        ? { directory }
        : this.defaultDirectory
          ? { directory: this.defaultDirectory }
          : undefined,
      body: body as any,
      // 透传 AbortSignal 到底层 fetch：opencode 的 session.prompt HTTP 请求会一直挂到
      // 整段对话（含 SessionSummary.summarize 之类的"善后" LLM 调用）结束才返回。
      // 不传 signal，bridge 端 watchdog 触发的 abort 只能让 SSE 订阅停下来，
      // sendPrompt 自己还是会卡到 30min undici 超时——前端就一直转圈圈。
      ...(options.signal ? { signal: options.signal } : {}),
    } as any);
    return unwrapData<Record<string, unknown>>(result);
  }

  // --------------------------- 通用事件订阅 ---------------------------

  /**
   * 通用 SSE 订阅。仅做事件透传，不做语义解析；
   * 想要业务化处理请用 chat()。
   */
  async subscribeEvents({
    onEvent,
    sessionId,
    includeChildren = true,
    signal,
  }: {
    onEvent: (event: EventEnvelope) => void | Promise<void>;
    sessionId?: string;
    includeChildren?: boolean;
    signal?: AbortSignal;
  }) {
    if (typeof onEvent !== "function") {
      throw new Error("onEvent 回调必填");
    }

    const allowed = new Set<string>();
    if (sessionId) {
      allowed.add(sessionId);
      if (includeChildren) {
        for (const id of await tryGetChildSessionIDs(this.client, sessionId)) {
          allowed.add(id);
        }
      }
    }

    const eventResult = await this.client.event.subscribe({
      query: this.defaultDirectory ? { directory: this.defaultDirectory } : undefined,
    });
    const stream = eventResult.stream;
    const onAbort = () => {
      const fn = (stream as any)?.return;
      if (typeof fn === "function") void fn.call(stream, undefined);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      for await (const event of stream as AsyncIterable<EventEnvelope>) {
        // 自动跟踪子 session
        if (includeChildren && sessionId && event.type === "session.created") {
          const info = event.properties?.info;
          const parent = info?.parentID || info?.parentId;
          if (parent && allowed.has(parent) && info?.id) allowed.add(info.id);
        }
        if (allowed.size > 0) {
          const evtSession = getSessionID(event);
          if (evtSession && !allowed.has(evtSession)) continue;
        }
        await onEvent(event);
      }
    } catch (err) {
      if (!isAbortError(err)) throw err;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  // --------------------------- chat：核心入口 ---------------------------

  /**
   * 一站式：建立 SSE 订阅 → 发起 prompt → 流式分发所有事件 → 拿到最终文本。
   *
   * 注意：handlers 中所有回调都是可选的；onRawEvent 会拿到 100% 的事件，
   * 业务化回调（onText / onTool / onSubagent ...）则只针对该语义触发。
   */
  async chat(
    sessionId: string,
    payload: SendPromptPayload,
    handlers: ChatHandlers = {},
    options: ChatOptions = {},
  ): Promise<{
    text: string;
    messageId: string | null;
    userMessageId: string | null;
    stats: {
      eventCount: number;
      textDeltaCount: number;
      toolCallCount: number;
      subagentCount: number;
      eventTypeCounter: Record<string, number>;
    };
  }> {
    assertNonEmptyString(sessionId, "sessionId");

    const {
      onUserMessage,
      onAssistantMessage,
      onText,
      onReasoning,
      onTool,
      onStep,
      onSubagent,
      onTodo,
      onSession,
      onStepFinish,
      onSessionStatus,
      onSessionIdle,
      onSessionError,
      onFileEdited,
      onPermission,
      onQuestion,
      onRawEvent,
      onUnhandledEvent,
      onError,
      onDone,
    } = handlers;

    const { streamTimeoutMs = 5 * 60 * 1000, idleTimeoutMs = 0, signal } = options;
    const FALLBACK_EMIT_DELAY_MS = 1500;
    const HEARTBEAT_ONLY_CLOSE_GRACE_MS = 3000;

    // ----- 状态 -----
    let stream: AsyncGenerator<EventEnvelope, unknown, unknown> | null = null;
    let assistantMsgId: string | null = null;
    let userMsgId: string | null = null;
    // 多轮 agent loop（call tool → tool result → next LLM turn）下，每一轮 LLM 调用
    // 都会产生一条独立的 assistant message。我们对每条消息各发一次 "started"，
    // 用 Set 跟踪而不是单一 boolean。
    const assistantStartedEmitted = new Set<string>();
    let finished = false;
    let promptResponseText = "";
    let hasNonHeartbeatEvent = false;
    let fallbackEmitTimer: NodeJS.Timeout | null = null;
    let heartbeatOnlyCloseTimer: NodeJS.Timeout | null = null;
    let fallbackChunkTimer: NodeJS.Timeout | null = null;

    // 文本累积器：messageId → fullText
    const textAcc = new Map<string, string>();
    const reasoningAcc = new Map<string, string>();
    const textPartAcc = new Map<string, string>();
    const reasoningPartAcc = new Map<string, string>();
    // 工具状态机：partID → 上一次状态，防止重复 start
    const toolStatusSeen = new Map<string, string>();
    const toolInputAcc = new Map<string, string>();
    const toolOutputAcc = new Map<string, string>();
    const toolMetaByPartID = new Map<
      string,
      { sessionID: string; messageID?: string; partID: string; callID?: string; name: string }
    >();

    // 统计
    let eventCount = 0;
    let textDeltaCount = 0;
    let toolCallCount = 0;
    let subagentCount = 0;
    const eventTypeCounter: Record<string, number> = {};
    const unknownEventSamples: Record<string, unknown>[] = [];

    // 子会话追踪
    const allowedSessionIDs = new Set<string>([sessionId]);
    const subagentSessionMeta = new Map<
      string,
      { agent?: string; description?: string; prompt?: string; parentID: string }
    >();
    for (const cid of await tryGetChildSessionIDs(this.client, sessionId)) {
      allowedSessionIDs.add(cid);
    }

    // 订阅就绪信号：必须在 SSE 建立后才发 prompt，避免漏首批事件。
    let resolveReady: () => void = () => {};
    let rejectReady: (e: unknown) => void = () => {};
    let readyResolved = false;
    const subscriptionReady = new Promise<void>((res, rej) => {
      resolveReady = () => {
        if (!readyResolved) {
          readyResolved = true;
          res();
        }
      };
      rejectReady = (e) => {
        if (!readyResolved) {
          readyResolved = true;
          rej(e);
        }
      };
    });

    // 空闲计时器
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        this.log("warn", "chat.idle.timeout", { sessionId, idleTimeoutMs });
        finished = true;
        const fn = (stream as any)?.return;
        if (typeof fn === "function") void fn.call(stream, undefined);
      }, idleTimeoutMs);
    };

    this.log("info", "chat.start", {
      sessionId,
      agent: payload?.agent || "build",
      providerID: payload?.model?.providerID,
      modelID: payload?.model?.modelID,
      directory: payload?.directory || this.defaultDirectory || null,
      streamTimeoutMs,
      idleTimeoutMs,
    });

    const clearFallbackChunkTimer = () => {
      if (fallbackChunkTimer) {
        clearInterval(fallbackChunkTimer);
        fallbackChunkTimer = null;
      }
    };

    const emitFallbackTextIncrementally = (fullText: string) => {
      if (!assistantMsgId || !fullText || finished) return;
      clearFallbackChunkTimer();

      const chunkSize = 24;
      const intervalMs = 20;
      let cursor = 0;

      fallbackChunkTimer = setInterval(() => {
        if (!assistantMsgId || finished) {
          clearFallbackChunkTimer();
          return;
        }
        if (cursor >= fullText.length) {
          clearFallbackChunkTimer();
          return;
        }
        // 若真实 SSE 文本已经开始推进，则停止 fallback chunk 发送。
        const current = textAcc.get(assistantMsgId) ?? "";
        if (current.length > 0 && !fullText.startsWith(current)) {
          clearFallbackChunkTimer();
          return;
        }

        const delta = fullText.slice(cursor, cursor + chunkSize);
        const nextFullText = current + delta;
        textAcc.set(assistantMsgId, nextFullText);
        onText?.({
          sessionID: sessionId,
          messageID: assistantMsgId,
          partID: "fallback",
          delta,
          fullText: nextFullText,
        });
        textDeltaCount += 1;
        cursor += chunkSize;
      }, intervalMs);
    };

    // -------------------- 事件消费循环 --------------------
    // 关键：event.subscribe 必须按 directory 过滤，否则 opencode 不会把该 workspace 下
    // 的 message.part.* 事件流送过来——只剩 server.heartbeat。优先用本次 prompt 的
    // directory（payload.directory），退到客户端默认 directory。
    const subscribeDirectory =
      (payload as { directory?: string } | undefined)?.directory ||
      this.defaultDirectory ||
      undefined;
    const subPromise = (async () => {
      let onAbort: (() => void) | null = null;
      try {
        const eventResult = await this.client.event.subscribe({
          query: subscribeDirectory ? { directory: subscribeDirectory } : undefined,
        });
        stream = eventResult.stream as any;

        onAbort = () => {
          const fn = (stream as any)?.return;
          if (typeof fn === "function") void fn.call(stream, undefined);
          this.log("warn", "chat.event.aborted", { sessionId });
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        resolveReady();
        resetIdleTimer();

        for await (const evt of stream as AsyncIterable<EventEnvelope>) {
          eventCount += 1;
          resetIdleTimer();
          const eventType = evt.type || "unknown";
          eventTypeCounter[eventType] = (eventTypeCounter[eventType] || 0) + 1;
          if (eventType !== "server.connected" && eventType !== "server.heartbeat") {
            hasNonHeartbeatEvent = true;
          }

          // session.created 链路追踪：先于 session 过滤！
          if (evt.type === "session.created") {
            const info = evt.properties?.info;
            const parent = info?.parentID || info?.parentId;
            const newId = info?.id as string | undefined;
            if (newId && parent && allowedSessionIDs.has(parent)) {
              allowedSessionIDs.add(newId);
              if (parent !== sessionId || newId !== sessionId) {
                subagentSessionMeta.set(newId, {
                  parentID: parent,
                  agent: info?.agent,
                  description: info?.description,
                });
              }
            }
          }

          const evtSession = getSessionID(evt);
          if (evtSession && !allowedSessionIDs.has(evtSession)) continue;

          // 100% 原始事件透传
          onRawEvent?.(evt);

          const isSubagent =
            evtSession !== undefined &&
            evtSession !== sessionId &&
            allowedSessionIDs.has(evtSession);

          // ===== 分发 =====
          switch (evt.type) {
            // ----------- 消息 part 增量 -----------
            case "message.part.updated": {
              const part = evt.properties?.part;
              if (!part) break;
              const pSession = part.sessionID || part.sessionId || evtSession || sessionId;
              const pMessage = part.messageID || part.messageId;
              const pId = part.id;

              // 文本增量
              if (part.type === "text" && typeof part.text === "string") {
                // 跳过用户消息的 text part：opencode 把用户输入也作为 message.part 流出来，
                // 不过滤的话 user 文字会被当成 agent 输出（symptom: "把我这句话打印出来了"）。
                if (userMsgId && pMessage === userMsgId) break;
                const prev = textAcc.get(pMessage) ?? "";
                const incomingDelta =
                  typeof evt.properties?.delta === "string"
                    ? evt.properties.delta
                    : part.text.startsWith(prev)
                      ? part.text.slice(prev.length)
                      : part.text;
                textAcc.set(pMessage, part.text);
                if (typeof pId === "string" && pId) textPartAcc.set(pId, part.text);

                if (incomingDelta) {
                  textDeltaCount += 1;
                  if (isSubagent) {
                    subagentCount += 1;
                    onSubagent?.({
                      phase: "text",
                      parentSessionID:
                        subagentSessionMeta.get(pSession)?.parentID || sessionId,
                      sessionID: pSession,
                      agent: subagentSessionMeta.get(pSession)?.agent,
                      textDelta: incomingDelta,
                      raw: evt,
                    });
                  } else {
                    onText?.({
                      sessionID: pSession,
                      messageID: pMessage,
                      partID: pId,
                      delta: incomingDelta,
                      fullText: part.text,
                    });
                  }
                }
              }
              // 推理增量
              else if (part.type === "reasoning" && typeof part.text === "string") {
                // 同上：跳过用户消息的 reasoning part（理论上不存在，但保险起见）
                if (userMsgId && pMessage === userMsgId) break;
                const prev = reasoningAcc.get(pMessage) ?? "";
                const delta =
                  typeof evt.properties?.delta === "string"
                    ? evt.properties.delta
                    : part.text.startsWith(prev)
                      ? part.text.slice(prev.length)
                      : part.text;
                reasoningAcc.set(pMessage, part.text);
                if (typeof pId === "string" && pId) reasoningPartAcc.set(pId, part.text);

                if (isSubagent) {
                  onSubagent?.({
                    phase: "reasoning",
                    parentSessionID:
                      subagentSessionMeta.get(pSession)?.parentID || sessionId,
                    sessionID: pSession,
                    agent: subagentSessionMeta.get(pSession)?.agent,
                    textDelta: delta,
                    raw: evt,
                  });
                } else if (delta) {
                  onReasoning?.({
                    sessionID: pSession,
                    messageID: pMessage,
                    partID: pId,
                    delta,
                    fullText: part.text,
                  });
                }
              }
              // 工具调用：根据 state.status 区分阶段
              else if (part.type === "tool") {
                const status = part.state?.status || part.status;
                const toolName = part.tool || part.name || "unknown";
                const prev = toolStatusSeen.get(pId);

                let phase: ToolPhase = "delta";
                if (!prev && status !== "completed" && status !== "error") {
                  phase = "start";
                  toolCallCount += 1;
                } else if (status === "completed") {
                  phase = "end";
                } else if (status === "error") {
                  phase = "error";
                }
                toolStatusSeen.set(pId, status || "unknown");
                if (typeof pId === "string" && pId) {
                  toolMetaByPartID.set(pId, {
                    sessionID: pSession,
                    messageID: typeof pMessage === "string" ? pMessage : undefined,
                    partID: pId,
                    callID: part.callID || part.callId,
                    name: toolName,
                  });
                }

                // task / subtask 工具触发 subagent 派发
                const taskSessionID =
                  part.state?.taskSessionID ||
                  part.state?.taskSessionId ||
                  part.taskSessionID ||
                  part.taskSessionId;
                if (taskSessionID) {
                  allowedSessionIDs.add(taskSessionID);
                  if (phase === "start") {
                    onSubagent?.({
                      phase: "dispatched",
                      parentSessionID: pSession,
                      sessionID: taskSessionID,
                      agent: part.state?.input?.agent || part.state?.agent,
                      description: part.state?.input?.description,
                      prompt: part.state?.input?.prompt,
                      raw: evt,
                    });
                  }
                }

                const toolEvent: ToolCallEvent = {
                  phase,
                  sessionID: pSession,
                  messageID: pMessage,
                  partID: pId,
                  callID: part.callID || part.callId,
                  name: toolName,
                  status,
                  input: part.state?.input,
                  output: part.state?.output,
                  error: part.state?.error,
                  taskSessionID,
                  metadata: part.state?.metadata,
                };

                if (isSubagent) {
                  onSubagent?.({
                    phase: "tool",
                    parentSessionID:
                      subagentSessionMeta.get(pSession)?.parentID || sessionId,
                    sessionID: pSession,
                    agent: subagentSessionMeta.get(pSession)?.agent,
                    tool: toolEvent,
                    raw: evt,
                  });
                } else {
                  onTool?.(toolEvent);
                }
              }
              // step-start / step-finish
              else if (part.type === "step-start" || part.type === "step-finish") {
                const stepEvent: StepEvent = {
                  phase: part.type === "step-start" ? "start" : "finish",
                  sessionID: pSession,
                  messageID: pMessage,
                  partID: pId,
                  reason: part.reason || part.state?.reason,
                  tokens: part.tokens || part.state?.tokens,
                  cost: part.cost || part.state?.cost,
                };
                onStep?.(stepEvent);
                if (stepEvent.phase === "finish") onStepFinish?.(stepEvent);
              }
              // agent / subtask 类型 part（部分版本会单独发）
              else if (part.type === "agent" || part.type === "subtask") {
                onSubagent?.({
                  phase: "dispatched",
                  parentSessionID: pSession,
                  sessionID: part.taskSessionID || part.taskSessionId,
                  agent: part.agent || part.name,
                  description: part.description,
                  prompt: part.prompt,
                  raw: evt,
                });
                const tsid = part.taskSessionID || part.taskSessionId;
                if (tsid) allowedSessionIDs.add(tsid);
              }
              break;
            }

            case "message.part.delta": {
              const p = evt.properties || {};
              const pSession = p.sessionID || p.sessionId || evtSession || sessionId;
              const messageID = p.messageID || p.messageId;
              const partID = p.partID || p.partId;
              const field = p.field;
              const delta = p.delta;

              if (
                typeof messageID !== "string" ||
                typeof field !== "string" ||
                typeof delta !== "string" ||
                delta.length === 0
              ) {
                break;
              }

              // opencode 把 reasoning 增量也用 field="text" 发出来（因为它是 reasoning part 的 text 字段
              // 在更新——见 opencode session/processor.ts reasoning-delta 分支）。光看 field 会把
              // R1/deepseek-reasoner 这类模型的思考内容当成正文输出。这里用 partID 做二次判断：
              // 若该 partID 已经在 reasoningPartAcc 注册过（由先到的 message.part.updated{type=reasoning}
              // 建立），则不管 field 是什么，都按 reasoning 处理。
              const isReasoningPart =
                typeof partID === "string" && partID.length > 0 && reasoningPartAcc.has(partID);

              if (field === "text" && !isReasoningPart) {
                const messageFullText = (textAcc.get(messageID) ?? "") + delta;
                textAcc.set(messageID, messageFullText);
                textDeltaCount += 1;
                const partFullText =
                  typeof partID === "string" && partID
                    ? (textPartAcc.get(partID) ?? "") + delta
                    : null;
                if (partFullText !== null) textPartAcc.set(partID, partFullText);
                const fullText = partFullText ?? messageFullText;

                if (isSubagent) {
                  subagentCount += 1;
                  onSubagent?.({
                    phase: "text",
                    parentSessionID: subagentSessionMeta.get(pSession)?.parentID || sessionId,
                    sessionID: pSession,
                    agent: subagentSessionMeta.get(pSession)?.agent,
                    textDelta: delta,
                    raw: evt,
                  });
                } else {
                  onText?.({
                    sessionID: pSession,
                    messageID,
                    partID: partID,
                    delta,
                    fullText,
                  });
                }
              } else if (field === "reasoning" || isReasoningPart) {
                const messageFullText = (reasoningAcc.get(messageID) ?? "") + delta;
                reasoningAcc.set(messageID, messageFullText);
                const partFullText =
                  typeof partID === "string" && partID
                    ? (reasoningPartAcc.get(partID) ?? "") + delta
                    : null;
                if (partFullText !== null) reasoningPartAcc.set(partID, partFullText);
                const fullText = partFullText ?? messageFullText;

                if (isSubagent) {
                  subagentCount += 1;
                  onSubagent?.({
                    phase: "reasoning",
                    parentSessionID: subagentSessionMeta.get(pSession)?.parentID || sessionId,
                    sessionID: pSession,
                    agent: subagentSessionMeta.get(pSession)?.agent,
                    textDelta: delta,
                    raw: evt,
                  });
                } else {
                  onReasoning?.({
                    sessionID: pSession,
                    messageID,
                    partID: partID,
                    delta,
                    fullText,
                  });
                }
              } else {
                const normalizedField = field.replace(/_/g, "-");
                if (
                  typeof partID === "string" &&
                  partID &&
                  (normalizedField === "tool-input" || normalizedField === "tool-output")
                ) {
                  const meta = toolMetaByPartID.get(partID);
                  if (normalizedField === "tool-input") {
                    const fullInput = (toolInputAcc.get(partID) ?? "") + delta;
                    toolInputAcc.set(partID, fullInput);
                    if (meta) {
                      const toolEvent: ToolCallEvent = {
                        phase: "delta",
                        sessionID: meta.sessionID,
                        messageID: meta.messageID,
                        partID: meta.partID,
                        callID: meta.callID,
                        name: meta.name,
                        status: toolStatusSeen.get(partID),
                        input: fullInput,
                      };
                      if (isSubagent) {
                        onSubagent?.({
                          phase: "tool",
                          parentSessionID:
                            subagentSessionMeta.get(meta.sessionID)?.parentID || sessionId,
                          sessionID: meta.sessionID,
                          agent: subagentSessionMeta.get(meta.sessionID)?.agent,
                          tool: toolEvent,
                          raw: evt,
                        });
                      } else {
                        onTool?.(toolEvent);
                      }
                    }
                  } else {
                    const fullOutput = (toolOutputAcc.get(partID) ?? "") + delta;
                    toolOutputAcc.set(partID, fullOutput);
                    if (meta) {
                      const toolEvent: ToolCallEvent = {
                        phase: "delta",
                        sessionID: meta.sessionID,
                        messageID: meta.messageID,
                        partID: meta.partID,
                        callID: meta.callID,
                        name: meta.name,
                        status: toolStatusSeen.get(partID),
                        output: fullOutput,
                      };
                      if (isSubagent) {
                        onSubagent?.({
                          phase: "tool",
                          parentSessionID:
                            subagentSessionMeta.get(meta.sessionID)?.parentID || sessionId,
                          sessionID: meta.sessionID,
                          agent: subagentSessionMeta.get(meta.sessionID)?.agent,
                          tool: toolEvent,
                          raw: evt,
                        });
                      } else {
                        onTool?.(toolEvent);
                      }
                    }
                  }
                }
              }

              break;
            }

            // ----------- 消息整体 -----------
            case "message.updated": {
              const info = evt.properties?.info;
              if (!info) break;

              // 用户消息
              if (info.role === "user") {
                userMsgId = info.id || userMsgId;
                const text = extractTextFromParts(info.parts || []);
                onUserMessage?.({
                  sessionID: info.sessionID || info.sessionId || evtSession || sessionId,
                  messageID: info.id,
                  text,
                  parts: info.parts || [],
                  raw: info,
                });
                break;
              }

              // 助手消息
              if (info.role === "assistant") {
                // 多轮 agent loop 里每一轮 LLM 调用都是一条独立的 assistant message。
                // 不能锁死第一条 ID 然后跳过后续——之前那么做导致 tool_call → tool_result
                // 之后的 reasoning/text 全部被吞掉，前端看到工具结果就再无下文。
                // 这里始终用最新的 info.id 作为"当前 assistant message"。
                assistantMsgId = info.id;

                if (!assistantStartedEmitted.has(info.id)) {
                  assistantStartedEmitted.add(info.id);
                  onAssistantMessage?.({
                    sessionID:
                      info.sessionID || info.sessionId || evtSession || sessionId,
                    messageID: info.id,
                    status: "started",
                    info,
                  });
                }

                const nextText = extractTextFromParts(info.parts || []);
                if (nextText) {
                  const prev = textAcc.get(info.id) ?? "";
                  const delta = nextText.startsWith(prev)
                    ? nextText.slice(prev.length)
                    : nextText;
                  textAcc.set(info.id, nextText);
                  if (delta) {
                    textDeltaCount += 1;
                    onText?.({
                      sessionID:
                        info.sessionID || info.sessionId || evtSession || sessionId,
                      messageID: info.id,
                      partID: "message.updated",
                      delta,
                      fullText: nextText,
                    });
                  }
                }

                if (info.error) {
                  onAssistantMessage?.({
                    sessionID:
                      info.sessionID || info.sessionId || evtSession || sessionId,
                    messageID: info.id,
                    status: "error",
                    info,
                    error: info.error,
                  });
                  onError?.(new Error(info.error.message || "模型执行出错"));
                  finished = true;
                  break;
                }

                if (info.time?.completed) {
                  onAssistantMessage?.({
                    sessionID:
                      info.sessionID || info.sessionId || evtSession || sessionId,
                    messageID: info.id,
                    status: "completed",
                    info,
                  });
                  // finish 是 LLM 给出的本轮收尾理由：
                  //   - "tool-calls"：本轮调了工具，opencode 会拿工具结果再发起下一轮 LLM 调用，
                  //                  所以本条 message 完成 ≠ 整段对话结束，不能把 finished 拉起来。
                  //   - "stop"/"length"/"content-filter"/...：终止性 finish，本次 prompt 真的没下文了。
                  // 之前不分类一律 finished=true，导致多轮工具循环里第二轮事件全都收不到。
                  const finishReason = (info.finish ?? info.finishReason) as string | undefined;
                  if (finishReason && finishReason !== "tool-calls") {
                    finished = true;
                  }
                } else {
                  onAssistantMessage?.({
                    sessionID:
                      info.sessionID || info.sessionId || evtSession || sessionId,
                    messageID: info.id,
                    status: "updated",
                    info,
                  });
                }
              }
              break;
            }

            case "message.part.removed":
            case "message.removed":
              // 透传由 onRawEvent 完成；此处不需要业务回调。
              break;

            // ----------- 会话生命周期 -----------
            case "session.created":
              onSession?.({
                phase: "created",
                sessionID: evt.properties?.info?.id || evtSession || sessionId,
                info: evt.properties?.info,
                raw: evt,
              });
              break;
            case "session.updated":
              onSession?.({
                phase: "updated",
                sessionID: evtSession || sessionId,
                info: evt.properties?.info,
                raw: evt,
              });
              break;
            case "session.deleted":
              onSession?.({
                phase: "deleted",
                sessionID: evtSession || sessionId,
                info: evt.properties?.info,
                raw: evt,
              });
              break;
            case "session.compacted":
              onSession?.({
                phase: "compacted",
                sessionID: evtSession || sessionId,
                info: evt.properties,
                raw: evt,
              });
              break;
            case "session.diff":
              onSession?.({
                phase: "diff",
                sessionID: evtSession || sessionId,
                info: evt.properties,
                raw: evt,
              });
              break;
            case "session.idle": {
              const sid = evtSession || sessionId;
              if (isSubagent) {
                onSubagent?.({
                  phase: "idle",
                  parentSessionID:
                    subagentSessionMeta.get(sid)?.parentID || sessionId,
                  sessionID: sid,
                  agent: subagentSessionMeta.get(sid)?.agent,
                  raw: evt,
                });
              } else {
                const idleEvent: SessionLifecycleEvent = {
                  phase: "idle",
                  sessionID: sid,
                  raw: evt,
                };
                onSession?.(idleEvent);
                onSessionIdle?.(idleEvent);
              }
              break;
            }
            case "session.status":
              const statusEvent: SessionLifecycleEvent = {
                phase: "status",
                sessionID: evtSession || sessionId,
                status: evt.properties?.status,
                raw: evt,
              };
              onSession?.(statusEvent);
              onSessionStatus?.(statusEvent);
              break;
            case "session.error": {
              const err = evt.properties?.error;
              const sid = evtSession || sessionId;
              if (isSubagent) {
                onSubagent?.({
                  phase: "error",
                  parentSessionID:
                    subagentSessionMeta.get(sid)?.parentID || sessionId,
                  sessionID: sid,
                  agent: subagentSessionMeta.get(sid)?.agent,
                  error: err,
                  raw: evt,
                });
              } else {
                const errorEvent: SessionLifecycleEvent = {
                  phase: "error",
                  sessionID: sid,
                  error: err,
                  raw: evt,
                };
                onSession?.(errorEvent);
                onSessionError?.(errorEvent);
                onError?.(new Error(err?.message || JSON.stringify(err) || "session 错误"));
                finished = true;
              }
              break;
            }

            // ----------- 提问 -----------
            case "question.asked": {
              const p = (evt.properties || {}) as Record<string, any>;
              if (!p.id) break;
              const ev: QuestionAskEvent = {
                id: p.id,
                sessionID: evtSession || sessionId,
                questions: p.questions,
                messageID: p.messageID || p.messageId,
              };
              // 用户思考期间不算 idle——挂起 idleTimer 直到应答完，否则 30s 后 stream
              // 自闭，应答虽 200 但 bridge 已收完最后一帧，前端永远转圈。
              if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
              try {
                const reply = await onQuestion?.(ev);
                // reply 形态：bridge 那边返回 string[][]（多 sub-question 各自答案）、
                // string[]（单问题/兼容老前端）或 null（跳过）。respondQuestion 会按 schema
                // 把 string[] 自动包成 [[...]]，前端 QuestionBlock 多问题模式直接传 string[][]。
                const answers = Array.isArray(reply) && reply.length > 0 ? reply : null;
                await this.respondQuestion(ev.id, answers);
              } catch (e) {
                this.log("error", "chat.question.reply.failed", {
                  error: (e as Error).message,
                });
              } finally {
                resetIdleTimer();
              }
              break;
            }

            // ----------- 权限 -----------
            case "permission.updated":
            case "permission.asked": {
              const p = (evt.properties || {}) as Record<string, any>;
              if (!p.id || !p.sessionID) break;
              const ev: PermissionAskEvent = {
                id: p.id,
                sessionID: p.sessionID || p.sessionId,
                messageID: p.messageID || p.messageId,
                callID: p.callID || p.callId,
                title: p.title,
                type: p.type,
                pattern: p.pattern,
                metadata: p.metadata,
              };
              // 同 question.asked：用户审批期间不算 idle，否则 30s 后 stream 自闭。
              if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
              try {
                const reply = (await onPermission?.(ev)) ?? "once";
                // 旧代码这里走 `(this.client as any).permission?.reply` 永远是 undefined，
                // 详见 respondPermission 注释。改成 raw fetch session-scoped 路径。
                await this.respondPermission(ev.sessionID, ev.id, reply);
              } catch (e) {
                this.log("error", "chat.permission.reply.failed", {
                  error: (e as Error).message,
                });
              } finally {
                resetIdleTimer();
              }
              break;
            }
            case "permission.replied":
              // 仅原始透传
              break;

            // ----------- TODO -----------
            case "todo.updated":
              onTodo?.({
                sessionID: evtSession || sessionId,
                todos: Array.isArray(evt.properties?.todos)
                  ? evt.properties.todos
                  : [],
              });
              break;

            // ----------- 文件/VCS/LSP -----------
            case "file.edited":
              onFileEdited?.({
                sessionID: evtSession,
                path: evt.properties?.path || evt.properties?.file,
                raw: evt,
              });
              break;
            case "file.watcher.updated":
            case "vcs.branch.updated":
            case "lsp.client.diagnostics":
            case "lsp.updated":
            case "command.executed":
            case "tui.prompt.append":
            case "tui.command.execute":
            case "tui.toast.show":
            case "pty.created":
            case "pty.updated":
            case "pty.exited":
            case "pty.deleted":
            case "server.connected":
            case "server.heartbeat":
            case "server.instance.disposed":
            case "installation.updated":
            case "installation.update-available":
              // 透传交给 onRawEvent
              break;

            default:
              onUnhandledEvent?.(evt);
              if (unknownEventSamples.length < 5) {
                unknownEventSamples.push({
                  type: evt.type,
                  sessionId: evtSession || null,
                  keys: Object.keys(evt.properties || {}),
                });
              }
              break;
          }

          if (finished) {
            const fn = (stream as any)?.return;
            if (typeof fn === "function") void fn.call(stream, undefined);
            break;
          }
        }
      } catch (err) {
        rejectReady(err);
        if (!isAbortError(err)) throw err;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        this.log("info", "chat.event.consume.done", {
          sessionId,
          eventCount,
          textDeltaCount,
          toolCallCount,
          subagentCount,
          eventTypeCounter,
          unknownEventSamples,
        });
      }
    })();

    // -------------------- 发送 prompt --------------------
    let response: any;
    try {
      await subscriptionReady;
      // 把 caller 的 signal 透传给 sendPrompt 的底层 fetch。
      // 没传 signal 时，sendPrompt 会一直挂到 opencode server 把"完整对话 + 善后 LLM 调用
      // (SessionSummary.summarize)"全部跑完才返回；caller 端 watchdog 触发的 abort 没法
      // 让它提前回收，导致 chat() 卡住、上层流不关、前端转圈。
      response = await this.sendPrompt(sessionId, payload, { signal });
    } catch (err) {
      const fn = (stream as any)?.return;
      if (typeof fn === "function") void fn.call(stream, undefined);
      // signal abort 是预期路径（caller 通过 watchdog 主动收尾），不算 error；不要往 caller 抛。
      if (isAbortError(err) || (signal && signal.aborted)) {
        this.log("warn", "chat.sendPrompt.aborted", { sessionId });
        finished = true;
      } else {
        this.log("error", "chat.sendPrompt.failed", {
          sessionId,
          error: (err as Error)?.message || String(err),
        });
        onError?.(err as Error);
        throw err;
      }
    }

    assistantMsgId =
      response?.info?.id || response?.message?.id || assistantMsgId;
    promptResponseText = extractTextFromPromptResponse(response);

    // 兜底：若短时间内未收到 text delta，再用 prompt 同步返回的文本补一刀。
    // 通过延迟避免与首批 SSE 增量事件竞态导致“一次性整段输出”。
    if (
      promptResponseText &&
      assistantMsgId &&
      !textAcc.get(assistantMsgId) &&
      !finished
    ) {
      fallbackEmitTimer = setTimeout(() => {
        if (!assistantMsgId || finished || textAcc.get(assistantMsgId)) return;
        emitFallbackTextIncrementally(promptResponseText);
      }, FALLBACK_EMIT_DELAY_MS);
    }

    // 仅 heartbeat 的兜底结束：给予 grace 时间，避免在事件尚未到达时误判并提前关闭流。
    if (
      promptResponseText &&
      !finished &&
      toolCallCount === 0 &&
      !hasNonHeartbeatEvent
    ) {
      heartbeatOnlyCloseTimer = setTimeout(() => {
        if (finished || hasNonHeartbeatEvent || toolCallCount > 0) return;
        if (eventCount === 0) return;
        if (
          !Object.keys(eventTypeCounter).every(
            (t) => t === "server.connected" || t === "server.heartbeat",
          )
        ) {
          return;
        }
        finished = true;
        const fn = (stream as any)?.return;
        if (typeof fn === "function") void fn.call(stream, undefined);
        this.log("warn", "chat.stream.heartbeat_only_fallback", {
          sessionId,
          assistantMsgId,
          eventCount,
        });
      }, HEARTBEAT_ONLY_CLOSE_GRACE_MS);
    }

    // -------------------- 等待事件循环结束 --------------------
    const safetyTimer = setTimeout(() => {
      this.log("warn", "chat.stream.timeout", { sessionId, streamTimeoutMs });
      const fn = (stream as any)?.return;
      if (typeof fn === "function") void fn.call(stream, undefined);
    }, streamTimeoutMs);

    try {
      await subPromise;
    } finally {
      clearTimeout(safetyTimer);
      if (fallbackEmitTimer) clearTimeout(fallbackEmitTimer);
      if (heartbeatOnlyCloseTimer) clearTimeout(heartbeatOnlyCloseTimer);
      clearFallbackChunkTimer();
      onDone?.();
    }

    const fullText =
      (assistantMsgId ? textAcc.get(assistantMsgId) : undefined) || promptResponseText || "";

    this.log("info", "chat.done", {
      sessionId,
      assistantMsgId,
      userMsgId,
      textLength: fullText.length,
      eventCount,
      textDeltaCount,
      toolCallCount,
      subagentCount,
    });

    return {
      text: fullText,
      messageId: assistantMsgId,
      userMessageId: userMsgId,
      stats: {
        eventCount,
        textDeltaCount,
        toolCallCount,
        subagentCount,
        eventTypeCounter,
      },
    };
  }
}

// =============================================================================
// Demo
// =============================================================================

async function demo() {
  const insight = new AgentInsight({
    baseURL: process.env.OPENCODE_URL || "http://127.0.0.1:4096",
    password: process.env.OPENCODE_SERVER_PASSWORD,
    timeout: 180_000,
    logLevel: (process.env.OPENCODE_LOG_LEVEL as LogLevel) || "info",
  });

  const session = await insight.createSession({ title: "opencode-client demo" });
  const sessionId = String((session as Record<string, unknown>)?.id ?? "");
  if (!sessionId) throw new Error("createSession 未返回有效 id");

  const payload: SendPromptPayload = {
    text:
      process.env.OPENCODE_DEMO_PROMPT ||
      "请用 ls 工具看看当前目录有哪些文件，然后用一句话总结。",
    agent: "build",
    model: {
      providerID: process.env.OPENCODE_PROVIDER_ID || "anthropic",
      modelID: process.env.OPENCODE_MODEL_ID || "claude-sonnet-4-5-20250929",
      apiKey: process.env.OPENCODE_API_KEY,
      baseURL: process.env.OPENCODE_PROVIDER_BASE_URL,
      headers: process.env.OPENCODE_PROVIDER_HEADERS
        ? JSON.parse(process.env.OPENCODE_PROVIDER_HEADERS)
        : undefined,
    },
    modelOptions: { temperature: 0.7, maxTokens: 2048 },
    directory: process.cwd(),
  };

  process.stdout.write(`session: ${sessionId}\n`);

  const result = await insight.chat(sessionId, payload, {
    onUserMessage: (e) =>
      process.stdout.write(`\n[user → ${e.messageID}] ${e.text.slice(0, 120)}\n`),
    onAssistantMessage: (e) =>
      process.stdout.write(`\n[assistant ${e.status}] ${e.messageID}\n`),
    onText: (e) => process.stdout.write(e.delta),
    onReasoning: (e) =>
      process.stdout.write(`\n[reasoning] ${e.delta.slice(0, 80)}…\n`),
    onTool: (e) =>
      process.stdout.write(
        `\n[tool ${e.phase}] ${e.name} status=${e.status ?? "?"}` +
          (e.phase === "end" && e.output
            ? ` output=${JSON.stringify(e.output).slice(0, 120)}`
            : "") +
          "\n",
      ),
    onSubagent: (e) =>
      process.stdout.write(
        `\n[subagent ${e.phase}] ${e.agent ?? "?"} session=${e.sessionID ?? "?"}` +
          (e.textDelta ? ` text="${e.textDelta.slice(0, 80)}"` : "") +
          (e.tool ? ` tool=${e.tool.name}/${e.tool.phase}` : "") +
          "\n",
      ),
    onStep: (e) =>
      process.stdout.write(
        `\n[step ${e.phase}] tokens=${JSON.stringify(e.tokens ?? {})} cost=${e.cost ?? "?"}\n`,
      ),
    onTodo: (e) => process.stdout.write(`\n[todo] count=${e.todos.length}\n`),
    onSession: (e) => process.stdout.write(`\n[session ${e.phase}] ${e.sessionID}\n`),
    onFileEdited: (e) => process.stdout.write(`\n[file.edited] ${e.path}\n`),
    onPermission: async (e) => {
      process.stdout.write(`\n[permission] ${e.title || e.type} → 自动 once\n`);
      return "once" as const;
    },
    onError: (err) => process.stderr.write(`\n[error] ${err.message}\n`),
  });

  process.stdout.write(
    `\n\n[done] messageId=${result.messageId ?? "unknown"} ` +
      `events=${result.stats.eventCount} text=${result.stats.textDeltaCount} ` +
      `tools=${result.stats.toolCallCount} subagents=${result.stats.subagentCount}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  demo().catch((err) => {
    process.stderr.write(`Failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
