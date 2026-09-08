import { hash, redact, type TurnEvidence } from './domain';

type Message = Record<string, any>;
function content(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => typeof v?.text === 'string' ? v.text : '').join('\n');
  return '';
}
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function replayTurns(interactions: Message[]): TurnEvidence[] {
  const turns: TurnEvidence[] = [];
  let current: TurnEvidence | undefined, responded = false, invalidTools = false, prompt = '';
  let calls = new Map<string, NonNullable<TurnEvidence['tools']>[number]>();
  const finish = () => { if (current && responded) { if (invalidTools) delete current.tools; turns.push(current); } };
  for (const m of interactions) {
    const role = m.role || m.type;
    if (role === 'system') { prompt = content(m.content); continue; }
    if (role === 'user') {
      finish(); responded = false; invalidTools = false; calls = new Map();
      current = { input: content(m.content), output: '', ...(prompt ? { systemPrompt: prompt } : {}) };
      continue;
    }
    if (!current) continue;
    if (role === 'assistant') {
      responded = true;
      const output = content(m.content);
      if (output) current.output = output;
      const facts = m.metadata?.evaluation;
      if (typeof facts?.skill === 'string') current.skill = facts.skill;
      if (typeof facts?.state === 'string') current.state = facts.state;
      if (Array.isArray(m.tool_calls)) {
        current.tools ??= [];
        for (const tool of m.tool_calls) {
          const fn = tool.function || tool;
          const args = json(fn.arguments);
          if (typeof fn.name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) { invalidTools = true; continue; }
          const call = { name: fn.name, arguments: args as Record<string, unknown> };
          current.tools.push(call);
          if (tool.id) calls.set(tool.id, call);
        }
      }
    } else if (role === 'tool') {
      const call = calls.get(m.tool_call_id);
      if (call) call.result = json(m.content);
    }
  }
  finish();
  return redact(turns) as TurnEvidence[];
}

export async function loadReplay(user: string, executionId: string, target: { id: string; name: string }) {
  const { prisma } = await import('../storage/prisma');
  const execution = await prisma.execution.findFirst({ where: { id: executionId, user } });
  if (!execution) throw new Error('Trace 不存在或无权访问');
  if (execution.agentName !== target.name) throw new Error('Trace 不属于所选 Agent');
  const previous = await prisma.experimentCase.findFirst({
    where: { executionId, experiment: { user, scope: 'evaluation-harness' } },
    include: { results: true, experiment: { select: { configSnapshotJson: true } } },
  });
  let turns: TurnEvidence[] = [], versionVerified = false;
  if (previous) {
    const original = JSON.parse(previous.experiment.configSnapshotJson || '{}');
    const originalTarget = original.groups?.find((g:any)=>g.id===previous.groupId)?.target || original.target;
    if (originalTarget?.id !== target.id) throw new Error('Trace 的 Agent 版本与所选版本不一致');
    versionVerified = original.traceSource !== 'existing' || original.replaySources?.some((s: any) => s.executionId === executionId && s.versionVerified);
    for (const result of previous.results) {
      const recorded = JSON.parse(result.evidenceJson || '{}').json;
      if (Array.isArray(recorded?.turns) && recorded.turns.length) { turns = recorded.turns; break; }
    }
  }
  if (!turns.length) {
    const refs = [
      ...(execution.agentSessionId ? [{ id: execution.agentSessionId }] : []),
      ...(execution.taskId ? [{ taskId: execution.taskId }] : []),
    ];
    const session = refs.length ? await prisma.session.findFirst({ where: { user, OR: refs } }) : null;
    if (!session) throw new Error('Trace 缺少可读取的会话');
    const parsed = JSON.parse(session.interactions || '[]');
    turns = replayTurns(Array.isArray(parsed) ? parsed : parsed.interactions || []);
  }
  if (!turns.length) throw new Error('Trace 未采集完整的用户输入与回复，无法进行逐轮评估');
  const evidence = redact(turns) as TurnEvidence[];
  return { executionId, taskId: execution.taskId, evidence, versionVerified: Boolean(versionVerified), evidenceHash: hash(evidence) };
}
