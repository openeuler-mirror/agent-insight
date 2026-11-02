/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 实验引擎的 LLM Judge 薄封装：发一段 system+user prompt，拿回完整文本。
 *
 * 未保存评估运行策略时，对齐任务完成度 / 轨迹评估器的旧传输层：
 * - 默认直连 ChatOpenAI（无 ephemeral opencode 进程）
 * - EVAL_FORCE_OPENCODE_TRANSPORT=1 强制走旧 ephemeral opencode
 * - 直连失败时回退 opencode（与 task-completion 一致）
 * 新策略只走直连，由尝试调度层统一控制预算和重试。
 * - 测试可 setJudgeLlmCallerForTest 注入
 */

import { isModelConnectionReady } from '@/lib/shared/model-connection';
import { experimentSignal } from './cancellation-context';
import type { ToolCallEvent } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import { hasEvaluatorExecutionPolicy, withConfiguredEvaluationTimeout } from './evaluator-execution-policy';
import { evaluationAttemptSignal, remainingEvaluationTimeMs, trackEvaluationRequest } from './evaluation-attempt';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';

export type JudgeSamplingProfile = 'canonical-trajectory';

export interface JudgeLlmRequest {
  system: string;
  user: string;
  timeoutMs?: number;
  /** 可选模型采样参数；不传时保持现有评估器行为。 */
  modelOptions?: Record<string, unknown>;
  /** opencode session 标题（可观测性用），缺省自动生成 */
  sessionTitle?: string;
  /** 仅供需要专属直连采样参数的评估请求使用。 */
  samplingProfile?: JudgeSamplingProfile;
  directory?: string;
  signal?: AbortSignal;
  onTool?: (event: ToolCallEvent) => void;
  onModel?: (model: string) => void;
  recordTrace?: { agentName: string; query: string };
  onTraceSaved?: (taskId: string) => void;
}

export type JudgeLlmCaller = (username: string, req: JudgeLlmRequest) => Promise<string>;

const DEFAULT_TIMEOUT_MS = Number(process.env.EXPERIMENT_JUDGE_TIMEOUT_MS || 180_000);

export interface DirectJudgeSamplingOptions {
  temperature: number;
  topP?: number;
  modelKwargs: Record<string, unknown>;
}

/** 构造直连 Judge 的采样参数；seed 属于兼容端点的 best-effort 参数。 */
export function buildDirectJudgeSamplingOptions(
  modelId: string,
  samplingProfile?: JudgeSamplingProfile,
): DirectJudgeSamplingOptions {
  const normalizedModelId = modelId.trim().toLowerCase();
  const isMimo25 = normalizedModelId === 'mimo-v2.5-pro' || normalizedModelId === 'mimo-v2.5';
  if (samplingProfile === 'canonical-trajectory' && isMimo25) {
    return {
      temperature: 0,
      modelKwargs: {
        seed: 42,
        thinking: { type: 'disabled' },
      },
    };
  }
  return {
    temperature: 0,
    topP: 1,
    modelKwargs: { seed: 42 },
  };
}

let injectedCaller: JudgeLlmCaller | null = null;

/** 测试注入点：传 null 恢复默认实现。 */
export function setJudgeLlmCallerForTest(fn: JudgeLlmCaller | null): void {
  injectedCaller = fn;
}

/** 测试用：是否已注入 fake judge（跳过真实模型门禁）。 */
export function hasJudgeLlmTestInjection(): boolean {
  return injectedCaller != null;
}

/** 统一入口：引擎只认这一个函数，实现可被测试替换。 */
export async function callJudgeLlm(username: string, req: JudgeLlmRequest): Promise<string> {
  experimentSignal()?.throwIfAborted();
  const remaining = remainingEvaluationTimeMs();
  if (remaining !== undefined) {
    const configured = { ...req, timeoutMs: remaining, signal: experimentSignal() };
    // 配置后的尝试只走直连；完整评分的回退不能绕过引擎重试预算。
    return trackEvaluationRequest(() => injectedCaller ? injectedCaller(username, configured) : directJudgeCaller(username, configured));
  }
  if (injectedCaller) return injectedCaller(username, req);

  const { shouldForceOpencodeEvalTransport } = await import(
    '@/lib/engine/evaluation/evaluator-execution-recorder'
  );

  if (shouldForceOpencodeEvalTransport()) {
    return opencodeJudgeCaller(username, req);
  }

  try {
    return await directJudgeCaller(username, req);
  } catch (directErr) {
    experimentSignal()?.throwIfAborted();
    console.warn(
      '[experiment-judge] direct LLM path failed, falling back to opencode transport:',
      (directErr as Error)?.message || directErr,
    );
    return opencodeJudgeCaller(username, req);
  }
}

/** 现行主路径：ChatOpenAI 单轮 invoke；只返回文本，不合成观测 Trace。 */
const directJudgeCaller: JudgeLlmCaller = async (username, req) => {
  const [
    { ChatOpenAI },
    { HumanMessage, SystemMessage },
    { getActiveConfig },
  ] = await Promise.all([
    import('@langchain/openai'),
    import('@langchain/core/messages'),
    import('@/lib/storage/server-config'),
  ]);

  const config = await getActiveConfig(username);
  if (!config || !isModelConnectionReady(config)) {
    throw new Error('未配置可用的评测模型，请到「模型注册」页完善连接信息');
  }

  const modelId = (config.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash';
  const timeoutMs = remainingEvaluationTimeMs() ?? req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = new ChatOpenAI({
    apiKey: config.apiKey || 'no-api-key',
    model: modelId,
    configuration: {
      baseURL: config.baseUrl || 'https://api.deepseek.com',
      defaultHeaders: config.headers,
    },
    ...buildDirectJudgeSamplingOptions(modelId, req.samplingProfile),
    timeout: timeoutMs,
    maxRetries: remainingEvaluationTimeMs() === undefined ? 2 : 0,
  });

  const response = await model.invoke([
    new SystemMessage(req.system),
    new HumanMessage(req.user),
  ], { signal: req.signal || experimentSignal() });
  const raw = typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content);

  if (!String(raw).trim()) {
    if (remainingEvaluationTimeMs() !== undefined) throw new JudgeOutputParseError('judge 未返回任何文本输出', '');
    throw new Error('judge 未返回任何文本输出');
  }
  return String(raw);
};

/** 旧路径 / 强制回退：per-call 临时 opencode server。 */
export const opencodeJudgeCaller: JudgeLlmCaller = async (username, req) => {
  const configured = hasEvaluatorExecutionPolicy();
  const executionController = new AbortController();
  const runtimeSignal = AbortSignal.any([executionController.signal, ...[req.signal, experimentSignal()].filter((s): s is AbortSignal => Boolean(s))]);
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
    runWithEphemeralOpencodeServer({ user: username, verbose: false, isolateHome: true, signal: runtimeSignal, requireCleanup: configured }, async (serverUrl: string) => {
      const config = await getActiveConfig(username);
      if (!config || !isModelConnectionReady(config)) {
        throw new Error('未配置可用的评测模型，请到「模型注册」页完善连接信息');
      }
      const activeModel = await loadServerModelForUser(username);
      const providerID =
        activeModel?.providerID
        || normalizeProviderID(config.provider || inferProviderFromBaseUrl(config.baseUrl));
      const modelID = activeModel?.modelID || config.model || 'deepseek-v4-flash';
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      req.onModel?.(modelID);

      let raw = '';
      let runtimeError: Error | null = null;

      const insight = new AgentInsight({ baseURL: serverUrl, logLevel: 'warn' });
      const sessionResp = await insight.createSession({
        title: req.sessionTitle ?? `experiment-judge-${Date.now()}`,
        directory: req.directory || '/tmp',
      });
      const session = sessionResp as { id?: unknown; ID?: unknown } | null | undefined;
      const sessionId = String(session?.id || session?.ID || '');
      if (!sessionId) throw new Error('Failed to create opencode session for experiment judge');

      const startedAt = new Date().toISOString();
      let executionFailure: unknown;
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const execute = async () => {
          const attemptSignal = evaluationAttemptSignal();
          const stop = () => executionController.abort(attemptSignal?.reason);
          attemptSignal?.addEventListener('abort', stop, { once: true });
          const executionTimeout = remainingEvaluationTimeMs() ?? timeoutMs;
          try {
            return await Promise.race([
              insight.chat(
                sessionId,
                {
                  text: req.user,
                  directory: req.directory,
                  agent: 'build',
                  model: {
                    providerID,
                    modelID,
                    apiKey: config.apiKey,
                    baseURL: config.baseUrl,
                    headers: config.headers,
                  },
                  ...(req.modelOptions ? { modelOptions: req.modelOptions } : {}),
                  system: req.system,
                  permission: buildEvaluatorPermissions(),
                },
                {
                  onText: (e: { delta: string }) => { raw += e.delta; },
                  onError: (e: Error) => { runtimeError = e; },
                  onTool: (e) => {
                    const secrets = [config.apiKey, ...Object.values(config.headers || {})].filter((s): s is string => typeof s === 'string' && s.length > 4);
                    let encoded = JSON.stringify(e);
                    for (const secret of secrets) encoded = encoded.split(secret).join('[REDACTED]');
                    req.onTool?.(JSON.parse(encoded));
                  },
                },
                { streamTimeoutMs: executionTimeout, idleTimeoutMs: executionTimeout, signal: attemptSignal || runtimeSignal },
              ),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => { executionController.abort(); reject(new Error(`LLM 调用超时（${executionTimeout}ms）`)); },
                  executionTimeout,
                );
              }),
            ]);
          } finally {
            attemptSignal?.removeEventListener('abort', stop);
            if (timer) { clearTimeout(timer); timer = null; }
          }
        };
        const result = configured ? await withConfiguredEvaluationTimeout(execute) : await execute();
        raw = (result as { text?: string }).text || raw;
        if (runtimeError) throw runtimeError;
      } catch (error) {
        executionFailure = error;
        throw error;
      } finally {
        if (req.recordTrace) {
          try {
            const { recordAgentJudgeExecution } = await import('@/lib/engine/evaluation/evaluator-execution-recorder');
            const secrets = [config.apiKey, ...Object.values(config.headers || {})].filter((s): s is string => typeof s === 'string' && s.length > 4);
            const redact = <T,>(value: T): T => {
              let encoded = JSON.stringify(value);
              for (const secret of secrets) encoded = encoded.split(secret).join('[REDACTED]');
              return JSON.parse(encoded);
            };
            const traceId = await recordAgentJudgeExecution({ listMessages: async id => redact(await insight.listMessages(id)) }, {
              taskId: sessionId, agentName: req.recordTrace.agentName, user: username,
              query: req.recordTrace.query, systemPrompt: redact(req.system), fallbackOutput: redact(raw), startedAt,
              completedAt: new Date().toISOString(),
              ...(executionFailure ? { failure: { code: 'agent-evaluation-failed', message: redact(executionFailure instanceof Error ? executionFailure.message : String(executionFailure)) } } : {}),
            });
            if (traceId) req.onTraceSaved?.(traceId);
          } catch { console.warn('[experiment-judge] 评估链路未能保存，本次结果不提供链路入口'); }
        }
        if (timer) clearTimeout(timer);
        try { await insight.deleteSession(sessionId); } catch { /* best-effort cleanup */ }
      }

      if (runtimeError) throw runtimeError;
      if (!raw.trim()) {
        if (configured) throw new JudgeOutputParseError('judge 未返回任何文本输出', raw);
        throw new Error('judge 未返回任何文本输出');
      }
      return raw;
    }),
  {
    taskType: 'experiment-judge',
    user: username,
    label: `experiment-judge: ${req.sessionTitle ?? ''}`.trim(),
    silent: true,
    signal: runtimeSignal,
  });
};
