/**
 * 实验引擎的 LLM Judge 薄封装：发一段 system+user prompt，拿回完整文本。
 *
 * - 默认实现仿照 runCustomLlmEvaluator（custom-llm-evaluator.ts）的 opencode 调用方式：
 *   AgentInsight client + createSession + insight.chat 流式 + 超时；重依赖全部 lazy import，
 *   避免单测（node --test）拉起 server-only 模块。
 * - 可注入：测试通过 setJudgeLlmCallerForTest 注入 fake judge（不真调 LLM）。
 */

import { isModelConnectionReady } from '@/lib/shared/model-connection';

export interface JudgeLlmRequest {
  system: string;
  user: string;
  timeoutMs?: number;
  /** opencode session 标题（可观测性用），缺省自动生成 */
  sessionTitle?: string;
}

export type JudgeLlmCaller = (username: string, req: JudgeLlmRequest) => Promise<string>;

const DEFAULT_TIMEOUT_MS = Number(process.env.EXPERIMENT_JUDGE_TIMEOUT_MS || 120_000);

let injectedCaller: JudgeLlmCaller | null = null;

/** 测试注入点：传 null 恢复默认 opencode 实现。 */
export function setJudgeLlmCallerForTest(fn: JudgeLlmCaller | null): void {
  injectedCaller = fn;
}

/** 统一入口：引擎只认这一个函数，实现可被测试替换。 */
export async function callJudgeLlm(username: string, req: JudgeLlmRequest): Promise<string> {
  return (injectedCaller ?? opencodeJudgeCaller)(username, req);
}

/** 默认实现：per-call 临时 opencode server，跑完即杀（与自建评估器运行时同型）。 */
const opencodeJudgeCaller: JudgeLlmCaller = async (username, req) => {
  // lazy import：这些模块是 server-only 重依赖，只有真调 LLM 时才加载
  const [
    { AgentInsight },
    { runWithEphemeralOpencodeServer },
    { withBackgroundOpencodeSlot },
    { buildEvaluatorPermissions },
    { getActiveConfig },
    { inferProviderFromBaseUrl, loadServerModelForUser, normalizeProviderID },
  ] = await Promise.all([
    import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-client'),
    import('@/lib/engine/skill-generation/opencode-agent-cli/opencode-manager'),
    import('@/lib/engine/general-agent/concurrency-limiter'),
    import('@/lib/engine/general-agent/workspace'),
    import('@/lib/storage/server-config'),
    import('@/lib/engine/general-agent/server-model-config'),
  ]);

  return withBackgroundOpencodeSlot(async () =>
    runWithEphemeralOpencodeServer({ user: username, verbose: false, isolateHome: true }, async (serverUrl: string) => {
      const config = await getActiveConfig(username);
      if (!config || !isModelConnectionReady(config)) {
        throw new Error('未配置可用的评测模型，请到「模型注册」页完善连接信息');
      }
      const activeModel = await loadServerModelForUser(username);
      const providerID =
        activeModel?.providerID
        || normalizeProviderID(config.provider || inferProviderFromBaseUrl(config.baseUrl));
      const modelID = activeModel?.modelID || config.model || 'deepseek-chat';
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      let raw = '';
      let runtimeError: Error | null = null;

      const insight = new AgentInsight({ baseURL: serverUrl, logLevel: 'warn' });
      const sessionResp = await insight.createSession({
        title: req.sessionTitle ?? `experiment-judge-${Date.now()}`,
        // 锁定 cwd 到 /tmp，避免误解析相对路径触发 read tool hang（同自建评估器）
        directory: '/tmp',
      });
      const sessionId = String((sessionResp as any)?.id || (sessionResp as any)?.ID || '');
      if (!sessionId) throw new Error('Failed to create opencode session for experiment judge');

      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const result = await Promise.race([
          insight.chat(
            sessionId,
            {
              text: req.user,
              agent: 'build',
              model: {
                providerID,
                modelID,
                apiKey: config.apiKey,
                baseURL: config.baseUrl,
                headers: config.headers,
              },
              system: req.system,
              permission: buildEvaluatorPermissions(),
            },
            {
              onText: (e: { delta: string }) => { raw += e.delta; },
              onError: (e: Error) => { runtimeError = e; },
            },
            { streamTimeoutMs: timeoutMs, idleTimeoutMs: timeoutMs },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`LLM 调用超时（${timeoutMs}ms）`)),
              timeoutMs,
            );
          }),
        ]);
        raw = (result as { text?: string }).text || raw;
      } finally {
        if (timer) clearTimeout(timer);
        try { await insight.deleteSession(sessionId); } catch { /* best-effort cleanup */ }
      }

      if (runtimeError) throw runtimeError;
      if (!raw.trim()) throw new Error('judge 未返回任何文本输出');
      return raw;
    }),
  {
    taskType: 'experiment-judge',
    user: username,
    label: `experiment-judge: ${req.sessionTitle ?? ''}`.trim(),
    silent: true,
  });
};
