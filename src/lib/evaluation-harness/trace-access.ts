import { apiFetch } from '@/lib/client/api';

export interface EvaluationTraceAccess {
  traceId: string;
  experimentId: string;
  caseId: string;
}

export async function loadEvaluationTraceAccess(
  traceId: string,
  apiKey: string,
  signal?: AbortSignal,
  request: typeof apiFetch = apiFetch,
): Promise<EvaluationTraceAccess> {
  if (!apiKey) throw new Error('请登录后查看 Trace');
  if (!traceId) throw new Error('请从实验 Case 打开 Trace');
  const response = await request('/api/evaluation-harness?traceId=' + encodeURIComponent(traceId), {
    headers: { 'x-witty-api-key': apiKey }, signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Trace 访问校验失败，请重试');
  if (data.traceId !== traceId || typeof data.experimentId !== 'string' || !data.experimentId
    || typeof data.caseId !== 'string' || !data.caseId) {
    throw new Error('Trace 访问校验响应无效，请重试');
  }
  return { traceId, experimentId: data.experimentId, caseId: data.caseId };
}
