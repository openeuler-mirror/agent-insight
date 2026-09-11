export interface BenchmarkFailurePresentation {
  code: string;
  label: string;
  message: string;
}

const FAILURE_META: Record<string, { label: string; message: string }> = {
  AGENT_TIMEOUT: {
    label: 'Agent 执行超时',
    message: 'Agent 在规定时间内未完成，执行进程已终止。',
  },
  MODEL_UNAVAILABLE: {
    label: '模型不可用',
    message: '模型或模型服务不可用，Agent 未能正常执行。',
  },
  MODEL_ERROR: {
    label: '模型调用失败',
    message: 'OpenCode 已报告模型或 Provider 错误，执行已提前终止。',
  },
  MODEL_NO_RESPONSE: {
    label: '模型未响应',
    message: 'OpenCode 会话已结束，但没有产生任何模型输出或工具调用。',
  },
  MODEL_START_TIMEOUT: {
    label: '等待模型响应超时',
    message: '会话已创建，但在首响应时限内未观察到模型活动。',
  },
  AGENT_EXIT_NONZERO: {
    label: 'Agent 异常退出',
    message: 'Agent 进程异常退出，未生成有效提交。',
  },
  AGENT_NO_OUTPUT: {
    label: 'Agent 无有效输出',
    message: 'Agent 已结束，但没有生成可评测的代码 Patch。',
  },
  TRACE_ID_MISSING: {
    label: 'Trace 未上报',
    message: 'Agent 执行结束，但没有获得有效 Trace ID。',
  },
};

const KNOWN_FAILURE_CODE = new RegExp(`\\b(${Object.keys(FAILURE_META).join('|')})\\b`);

export function benchmarkFailurePresentation(
  code: string | null | undefined,
  message: string | null | undefined,
): BenchmarkFailurePresentation | null {
  const normalizedMessage = message?.trim() || '';
  const normalizedCode = code?.trim() || normalizedMessage.match(KNOWN_FAILURE_CODE)?.[1] || '';
  if (!normalizedCode && !normalizedMessage) return null;

  const meta = FAILURE_META[normalizedCode];
  return {
    code: normalizedCode,
    label: meta?.label || 'Agent 执行失败',
    message: normalizedMessage && normalizedMessage !== normalizedCode
      ? normalizedMessage
      : meta?.message || 'Agent 执行未成功完成。',
  };
}
