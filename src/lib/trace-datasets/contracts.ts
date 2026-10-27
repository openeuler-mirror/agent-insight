export type GenerationConfig = { name: string; description: string; platform: string; agentKey: string; from: string; to: string; limit: number; requestId: string };
export type GenerationStatus = 'generating' | 'failed' | 'published';
export const STAGES = ['queued', 'read', 'dedup', 'stratify', 'sample', 'convert', 'save', 'complete', 'failed'] as const;
export const STAGE_LABELS: Record<string, string> = { queued: '排队中', read: '读取 Trace', dedup: '筛选与去重', stratify: '任务与行为归类', sample: '多样性采样', convert: '生成数据项', save: '保存数据集', complete: '生成完成', failed: '生成异常' };
export type GenerationSummary = { version: 1; sourceTraces: number; retainedTraces: number; candidateCount: number; duplicateCount: number; sampledOutCount: number | null; exclusions: { code: string; traceCount: number; turnCount: number }[] };
export const EXCLUSION_REASONS: Record<string, { label: string; explanation: string }> = {
  CONTEXT_UNCONFIRMED: { label: '上下文依赖无法确认', explanation: '缺少完整原始请求、明确轮次归属或无历史上下文的证据，无法确认输入可独立执行。' },
  CONTEXT_HISTORY: { label: '上下文依赖无法确认', explanation: '原始请求携带历史对话，无法确认当前输入脱离历史后仍然完整。' },
  CONTEXT_INPUT_LOSS: { label: '上下文依赖无法确认', explanation: '原始请求包含提取后的输入未保留的注入上下文或非文本内容。' },
  INPUT_CONTENT_UNSUPPORTED: { label: '输入包含非文本内容', explanation: '当前数据集仅支持文本，无法完整保留图片等输入内容。' },
  INPUT_UNATTRIBUTED: { label: '输入归属无法确认', explanation: '缺少明确用户输入、输入与任务记录不一致，或属于子 Agent。' },
  ANSWER_UNATTRIBUTED: { label: '最终回答无法确认', explanation: '缺少已结束主流程的明确最终回答，或回答与记录不一致、之后仍有工具活动。' },
  EXECUTION_NOT_SUCCESSFUL: { label: '执行未成功结束', explanation: '执行尚未结束或记录了任务失败。' },
  TRUNCATED: { label: '内容不完整', explanation: '记录包含截断或延迟加载的内容，无法提取完整问答。' },
  MISSING_TEXT: { label: '缺少问答文本', explanation: '输入或参考回答为空。' },
  SOURCE_CHANGED: { label: '来源发生变化', explanation: '冻结后 Trace 被更新，本次跳过；可重新生成。' },
  SOURCE_UNAVAILABLE: { label: '来源不可用', explanation: '找不到对应执行记录或交互记录。' },
};
export type GenerationProgress = { datasetId: string; jobId: string | null; status: GenerationStatus; stage: string; stageIndex: number; totalStages: number; generatedCount: number; summary: GenerationSummary | null; error: { code: string; message: string } | null; generationConfig: GenerationConfig | null; canCancel: boolean; canReturn: boolean; canFinish: boolean };
export const TRACE_FIELDS = [
  { id: 'input', key: 'input', label: 'input', type: 'text' as const, system: true },
  { id: 'reference_output', key: 'reference_output', label: 'reference_output', type: 'text' as const, system: true },
];
export class GenerationError extends Error {
  readonly isTraceDatasetGenerationError = true;
  // The persistent manager can outlive this module during Next development reloads.
  static [Symbol.hasInstance](value: unknown) { return value instanceof Error && ((value as GenerationError).isTraceDatasetGenerationError === true || value.constructor.name === 'GenerationError'); }
  constructor(public code: string, message: string, public status = 400, public details?: { deletionId: string }) { super(message); }
}
export function validateWindow(from: unknown, to: unknown, now = Date.now()) {
  const utc = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
  if (typeof from !== 'string' || typeof to !== 'string' || !utc.test(from) || !utc.test(to)) throw new GenerationError('INVALID_CONFIG', '时间范围必须为 UTC 时间');
  const start = Date.parse(from), end = Date.parse(to);
  if (![86400000, 7 * 86400000, 30 * 86400000].includes(end - start) || end > now + 300000) throw new GenerationError('INVALID_CONFIG', '请选择最近24小时、7天或30天');
  return { from, to };
}
export function validateConfig(raw: Record<string, unknown>, now = Date.now()): GenerationConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GenerationError('INVALID_CONFIG', '配置必须为对象');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const description = raw.description === undefined ? '' : raw.description;
  if (!name || name.length > 50 || typeof description !== 'string' || description.length > 200 || !Number.isInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 500) throw new GenerationError('INVALID_CONFIG', '名称为1–50字，描述最多200字，生成条数为1–500整数');
  if (typeof raw.platform !== 'string' || typeof raw.agentKey !== 'string' || !raw.agentKey || typeof raw.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.requestId)) throw new GenerationError('INVALID_CONFIG', '请选择平台与 Agent，并使用有效请求标识');
  return { name, description, platform: raw.platform, agentKey: raw.agentKey, ...validateWindow(raw.from, raw.to, now), limit: Number(raw.limit), requestId: raw.requestId.toLowerCase() };
}
export function requestTime(id: string) { return parseInt(id.replace(/-/g, '').slice(0, 12), 16); }
export function receiptExpiry(id: string, terminalTime: number) { return new Date(Math.max(terminalTime + 86400000, requestTime(id) + 86700000)); }
export function normalizeTraceCases(raw: unknown) {
  if (!Array.isArray(raw)) throw new GenerationError('INVALID_CONFIG', '数据项必须为数组', 422);
  const ids = new Set<string>();
  return raw.map(item => {
    const values = item?.values || { input: item?.input, reference_output: item?.expectedOutput };
    if (Object.keys(values).some(k => !['input', 'reference_output'].includes(k)) || typeof values.input !== 'string' || !values.input.trim() || typeof values.reference_output !== 'string' || !values.reference_output.trim()) throw new GenerationError('INVALID_CONFIG', 'input 与 reference_output 必须为非空文本，且只允许这两列', 422);
    const input = values.input.replace(/\r\n?/g, '\n').normalize('NFC');
    const output = values.reference_output.replace(/\r\n?/g, '\n').normalize('NFC');
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)) throw new GenerationError('INVALID_CONFIG', '数据项标识缺失或重复', 422);
    ids.add(item.id);
    return { id: item.id, input, expectedOutput: output, evaluationFocus: '', tags: [] as string[], trajectory: '', values: { input, reference_output: output } };
  });
}
