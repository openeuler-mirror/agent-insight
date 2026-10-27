import { normalizeText, taskType } from '../../lib/trace-datasets/sampling';

export type Event = { role?: string; content?: string; channel?: string; toolNames?: string[]; timestamp?: string; completedAt?: string; finishReason?: string; nonText?: boolean; subagent?: boolean; spanId?: string; traceId?: string; failed?: boolean; retry?: boolean; delegated?: boolean; truncated?: boolean; final?: boolean };
export type NormalizedUnit = { input: string; reference_output: string; task: string; cells: string[]; knownDimensions: number };
export type Source = { query: string; finalResult: string; completed: boolean; failed: boolean; isSubagent: boolean; events: Event[]; platform: string };
export type Exclusion = { code: string; turnCount: number };
export function normalizeSource(input: { query: string; finalResult: string; completed: boolean; failed: boolean; isSubagent: boolean; events: Event[]; platform: string }): { unit?: NormalizedUnit; reason?: string } {
  if (!input.completed || input.failed) return { reason: 'EXECUTION_NOT_SUCCESSFUL' };
  if (input.events.some(e => e.truncated)) return { reason: 'TRUNCATED' };
  const users = input.events.filter(e => e.role === 'user' && e.content?.trim());
  if (users.length !== 1) return { reason: users.length > 1 ? 'MULTI_TURN' : 'INPUT_UNATTRIBUTED' };
  if (users[0].nonText) return { reason: 'INPUT_CONTENT_UNSUPPORTED' };
  const task = normalizeText(users[0].content!);
  if (input.query && normalizeText(input.query) !== task) return { reason: 'INPUT_UNATTRIBUTED' };
  const answers = input.events.filter(e => e.role === 'assistant' && e.content?.trim() && !e.toolNames?.length && !['analysis', 'reasoning', 'thinking', 'commentary'].includes(e.channel || ''));
  const last = answers.at(-1);
  if (!last || (input.finalResult && normalizeText(last.content!) !== normalizeText(input.finalResult))) return { reason: 'ANSWER_UNATTRIBUTED' };
  if (last.failed || ['error', 'failed', 'cancelled', 'canceled', 'content_filter'].includes(last.finishReason || '')) return { reason: 'EXECUTION_NOT_SUCCESSFUL' };
  if (last.finishReason === 'length' || last.finishReason === 'max_tokens') return { reason: 'TRUNCATED' };
  if (['tool_calls', 'function_call', 'tool_use'].includes(last.finishReason || '')) return { reason: 'ANSWER_UNATTRIBUTED' };
  if (input.events.slice(input.events.lastIndexOf(last) + 1).some(e => e.role === 'tool' || e.toolNames?.length || e.failed)) return { reason: 'ANSWER_UNATTRIBUTED' };
  const output = normalizeText(last.content!);
  if (!task.trim() || !output.trim()) return { reason: 'MISSING_TEXT' };
  const toolEvents = input.events.flatMap((e, i) => (e.toolNames || []).map((name, j) => ({ name: `${input.platform}:${name}`, timestamp: e.timestamp || '', spanId: e.spanId || '', i, j })));
  toolEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.spanId.localeCompare(b.spanId) || a.i - b.i || a.j - b.j);
  const cells = new Set<string>();
  for (const e of toolEvents) cells.add(JSON.stringify(['tool', e.name]));
  for (let i = 1; i < toolEvents.length; i++) cells.add(JSON.stringify(['transition', toolEvents[i - 1].name, toolEvents[i].name]));
  // Stored interactions prove observed calls, but do not prove a collector captured every call.
  const observable = new Set<string>();
  if (toolEvents.length) observable.add('tool');
  if (toolEvents.length > 1) observable.add('transition');
  for (const [dimension, observed] of [['recovery', input.events.some(e => e.failed)], ['retry', input.events.some(e => e.retry)], ['delegation', input.events.some(e => e.delegated)]] as const) {
    if (observed) { cells.add(JSON.stringify([dimension, true])); observable.add(dimension); }
  }
  return { unit: { input: task, reference_output: output, task: taskType(task), cells: [...cells].sort(), knownDimensions: observable.size } };
}
