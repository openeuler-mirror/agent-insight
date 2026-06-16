/**
 * jiuwen (openJiuwen / JiuwenSwarm via agent-core) OTLP → agent-insight ExecutionRecord.
 *
 * agent-core's built-in OTLP exporter pushes its OTEL spans straight to
 * /api/ingest/otel/v1/traces; the route branches on resource service.name ===
 * "jiuwenswarm" and calls this aggregator. This is the TS port of the validated
 * Python bridge (`docs/designs/agents/jiuwenswarm-tracing/assets/insight_bridge.py`):
 * it rebuilds the agent tree from the (single-trace, nested) span set agent-core
 * emits since the develop rework (8b2a384) and maps it to an ExecutionRecord.
 *
 * Why a self-contained path (not the shared claude-otel normalizer): that
 * normalizer drops any span that isn't gen_ai/tool and requires a session.id it
 * doesn't recognize — it would gut jiuwen's structural agent.* / team.* spans. We
 * keep all spans and read agentteam.session.id here.
 */
import type { ExecutionRecord } from '@/lib/storage/data-service';
import { otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';

export type JiuwenSpan = {
  name: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  attrs: Record<string, any>;
  startNs: number;
  endNs: number;
};

function nanoToNumber(v: any): number {
  if (v == null) return 0;
  try {
    return Number(typeof v === 'bigint' ? v : BigInt(String(v)));
  } catch {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
}
const toMs = (ns: number): number => Math.floor(ns / 1_000_000);

/** Walk a decoded OTLP traces body into a flat span list. */
export function collectJiuwenSpans(body: any): JiuwenSpan[] {
  const out: JiuwenSpan[] = [];
  const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];
  for (const rs of resourceSpans) {
    const scopeSpans = Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : [];
    for (const ss of scopeSpans) {
      const spans = Array.isArray(ss?.spans) ? ss.spans : [];
      for (const span of spans) {
        out.push({
          name: String(span?.name || ''),
          traceId: span?.traceId ? String(span.traceId) : undefined,
          spanId: span?.spanId ? String(span.spanId) : undefined,
          parentSpanId: span?.parentSpanId ? String(span.parentSpanId) : undefined,
          attrs: otelAttrsToObject(span?.attributes || []),
          startNs: nanoToNumber(span?.startTimeUnixNano),
          endNs: nanoToNumber(span?.endTimeUnixNano),
        });
      }
    }
  }
  return out.sort((a, b) => a.startNs - b.startNs);
}

export function jiuwenServiceName(body: any): string | undefined {
  const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];
  for (const rs of resourceSpans) {
    const resource = otelAttrsToObject(rs?.resource?.attributes || []);
    const svc = resource['service.name'];
    if (svc) return String(svc);
  }
  return undefined;
}

function sessionId(spans: JiuwenSpan[]): string | undefined {
  for (const s of spans) {
    const sid = s.attrs['agentteam.session.id'];
    if (sid) return String(sid);
  }
  return undefined;
}

// ---- span helpers (mirror the Python bridge) -----------------------------

const isLlm = (s: JiuwenSpan) => s.name === 'llm.call';
const isTool = (s: JiuwenSpan) => s.name.startsWith('tool.');
const isAgentSpan = (s: JiuwenSpan) => s.name.startsWith('agent.') && s.name.includes('.task_iteration.');

function agentMember(s: JiuwenSpan): string {
  const m = s.attrs['agentteam.agent.id'];
  if (m) return String(m);
  const parts = s.name.split('.'); // agent.<member>.task_iteration.<n>
  return parts.length > 2 ? parts[1] : s.name;
}

function enclosingMember(s: JiuwenSpan, idx: Map<string, JiuwenSpan>, fallback: string): string {
  let cur: JiuwenSpan | undefined = s;
  const seen = new Set<string>();
  while (cur) {
    if (isAgentSpan(cur)) return agentMember(cur);
    const pid = cur.parentSpanId;
    if (!pid || seen.has(pid)) break;
    seen.add(pid);
    cur = idx.get(pid);
  }
  return fallback;
}

function completion(attrs: Record<string, any>): string {
  return String(attrs['gen_ai.completion.0.content'] ?? '');
}

/** jiuwen task tool output: "success=True data={...} error=None" -> data.output. */
function unwrapToolData(raw: any): string {
  const s = String(raw ?? '');
  const d = s.indexOf('data=');
  if (d >= 0) {
    let frag = s.slice(d + 5);
    const e = frag.lastIndexOf('} error=');
    if (e >= 0) frag = frag.slice(0, e + 1);
    const out = pyDictOutput(frag);
    if (out != null) return out;
  }
  return pyDictOutput(s) ?? s;
}

/** Pull `output` from a python-repr dict like "{'output': '...', ...}". */
function pyDictOutput(s: string): string | null {
  const m = s.match(/['"]output['"]\s*:\s*(['"])([\s\S]*?)\1\s*[,}]/);
  return m ? m[2] : null;
}

type Turn = { st: number; member: string; frag: any };

// ---- single agent --------------------------------------------------------

function transformSingle(spans: JiuwenSpan[], taskId: string, query: string, user?: string): ExecutionRecord {
  const idx = new Map(spans.filter((s) => s.spanId).map((s) => [s.spanId!, s] as const));
  const toolByParent = new Map<string, JiuwenSpan[]>();
  for (const s of spans) {
    if (isTool(s) && s.parentSpanId) {
      (toolByParent.get(s.parentSpanId) ?? toolByParent.set(s.parentSpanId, []).get(s.parentSpanId)!).push(s);
    }
  }
  const interactions: any[] = [{ role: 'user', content: query }];
  let inTok = 0, outTok = 0, totTok = 0, llm = 0, tools = 0, model = '', final = '';
  let first: number | null = null, last: number | null = null;
  for (const s of spans) {
    first = first === null ? s.startNs : Math.min(first, s.startNs);
    last = last === null ? s.endNs : Math.max(last, s.endNs);
    if (!isLlm(s)) continue;
    const a = s.attrs;
    llm++;
    const pt = Number(a['gen_ai.usage.prompt_tokens'] || 0);
    const ct = Number(a['gen_ai.usage.completion_tokens'] || 0);
    const tt = Number(a['gen_ai.usage.total_tokens'] || pt + ct);
    inTok += pt; outTok += ct; totTok += tt;
    model = String(a['gen_ai.request.model'] || model);
    const content = completion(a);
    if (content) final = content;
    const tcs = (toolByParent.get(s.spanId || '') ?? []).map((t) => {
      tools++;
      return {
        id: String(t.attrs['gen_ai.tool.id'] ?? t.spanId),
        type: 'function',
        function: { name: String(t.attrs['gen_ai.tool.name'] ?? t.name), arguments: String(t.attrs['gen_ai.tool.input'] ?? '') },
        state: 'success',
        output: unwrapToolData(t.attrs['gen_ai.tool.output']),
      };
    });
    interactions.push({
      role: 'assistant', content, tool_calls: tcs,
      usage: { input: pt, output: ct, total: tt }, modelID: model, agent: 'jiuwenswarm',
      timeInfo: { created: toMs(s.startNs), completed: toMs(s.endNs) },
    });
  }
  return record({
    taskId, query, agentName: 'jiuwenswarm/spike_agent', agents: ['jiuwenswarm/spike_agent'],
    model, inTok, outTok, totTok, tools, llm, first, last, final, interactions, user,
    subagentCount: 0,
  });
}

// ---- team (message-bus) — v3 parent-chain attribution --------------------

function transformTeam(spans: JiuwenSpan[], taskId: string, query: string, user?: string): ExecutionRecord {
  const idx = new Map(spans.filter((s) => s.spanId).map((s) => [s.spanId!, s] as const));
  const teamName = String(spans.find((s) => s.attrs['agentteam.team.name'])?.attrs['agentteam.team.name'] ?? 'team');

  const LEADER_TOOLS = new Set(['tool.spawn_teammate', 'tool.build_team', 'tool.create_task']);
  let leader = '';
  for (const s of spans) {
    if (LEADER_TOOLS.has(s.name)) { leader = enclosingMember(s, idx, ''); if (leader) break; }
  }
  if (!leader) {
    const agentSpans = spans.filter(isAgentSpan).sort((a, b) => a.startNs - b.startNs);
    if (agentSpans.length) leader = agentMember(agentSpans[0]);
  }
  leader = leader || 'team_leader';

  const turns: Turn[] = [];
  let inTok = 0, outTok = 0, totTok = 0, llm = 0, tools = 0, model = '', summary = '';
  let first: number | null = null, last: number | null = null;
  for (const s of spans) {
    first = first === null ? s.startNs : Math.min(first, s.startNs);
    last = last === null ? s.endNs : Math.max(last, s.endNs);
    const a = s.attrs;
    if (isLlm(s)) {
      llm++;
      const pt = Number(a['gen_ai.usage.prompt_tokens'] || 0);
      const ct = Number(a['gen_ai.usage.completion_tokens'] || 0);
      const tt = Number(a['gen_ai.usage.total_tokens'] || pt + ct);
      inTok += pt; outTok += ct; totTok += tt;
      if (!model) model = String(a['gen_ai.request.model'] || '');
      turns.push({ st: s.startNs, member: enclosingMember(s, idx, leader), frag: {
        content: completion(a), usage: { input: pt, output: ct, total: tt }, modelID: String(a['gen_ai.request.model'] || ''),
        tool_calls: [], timeInfo: { created: toMs(s.startNs), completed: toMs(s.endNs) },
      } });
    } else if (isTool(s)) {
      tools++;
      turns.push({ st: s.startNs, member: enclosingMember(s, idx, leader), frag: {
        content: '', tool_calls: [{
          id: String(a['gen_ai.tool.id'] ?? s.spanId), type: 'function',
          function: { name: String(a['gen_ai.tool.name'] ?? s.name.split('.').slice(1).join('.')), arguments: String(a['gen_ai.tool.input'] ?? '').slice(0, 2000) },
          state: 'success', output: String(a['gen_ai.tool.output'] ?? '').slice(0, 2000),
        }], timeInfo: { created: toMs(s.startNs), completed: toMs(s.endNs) },
      } });
    }
    if (isAgentSpan(s)) {
      const t = pyDictOutput(String(a['agentteam.agent.output'] ?? '')) ?? '';
      if (t.length > summary.length) summary = t;
    }
  }
  turns.sort((x, y) => x.st - y.st);
  const members = Array.from(new Set(turns.map((t) => t.member))).sort();
  const others = members.filter((m) => m !== leader);

  const interactions: any[] = [{ role: 'user', content: query }];
  const spawnTurn = others.length ? {
    role: 'assistant', agent: leader, content: '',
    tool_calls: others.map((m) => ({
      id: `spawn_${m}`, type: 'function',
      function: { name: 'task', arguments: JSON.stringify({ subagent_type: m, description: `spawn teammate ${m}` }) },
      state: 'success', output: `${m} joined the team`,
    })),
  } as any : null;
  let spawned = false;
  for (const t of turns) {
    if (t.member !== leader && !spawned && spawnTurn) {
      spawnTurn.timeInfo = { created: toMs(t.st), completed: toMs(t.st) };
      interactions.push(spawnTurn); spawned = true;
    }
    if (t.member === leader) interactions.push({ role: 'assistant', agent: leader, ...t.frag });
    else interactions.push({ role: 'subagent', agent: t.member, subagent_name: t.member, subagent_session_id: `${teamName}_${t.member}`, ...t.frag });
  }
  if (spawnTurn && !spawned) interactions.push(spawnTurn);

  return record({
    taskId, query, agentName: leader, agents: members, model, inTok, outTok, totTok, tools, llm,
    first, last, final: summary, interactions, user, subagentCount: Math.max(0, members.length - 1),
  });
}

// ---- task fan-out (isolated sub-agents) ----------------------------------

function transformTask(spans: JiuwenSpan[], taskId: string, query: string, user?: string): ExecutionRecord {
  let inTok = 0, outTok = 0, totTok = 0, llm = 0, model = '', planContent = '', mergeContent = '';
  let first: number | null = null, last: number | null = null;
  const taskSpans: JiuwenSpan[] = [];
  for (const s of spans) {
    first = first === null ? s.startNs : Math.min(first, s.startNs);
    last = last === null ? s.endNs : Math.max(last, s.endNs);
    const a = s.attrs;
    if (isLlm(s)) {
      llm++;
      const pt = Number(a['gen_ai.usage.prompt_tokens'] || 0);
      const ct = Number(a['gen_ai.usage.completion_tokens'] || 0);
      totTok += Number(a['gen_ai.usage.total_tokens'] || pt + ct);
      inTok += pt; outTok += ct;
      model = String(a['gen_ai.request.model'] || model);
      const c = completion(a);
      if (llm === 1) planContent = c;
      if (c) mergeContent = c;
    } else if (s.name.startsWith('tool.task')) {
      taskSpans.push(s);
    }
  }
  const final = mergeContent;

  const coordTools: any[] = [];
  const subs: any[] = [];
  taskSpans.sort((a, b) => a.startNs - b.startNs).forEach((ts, i) => {
    const a = ts.attrs;
    const rawIn = String(a['gen_ai.tool.input'] ?? '');
    let desc = rawIn, subType = 'general-purpose';
    const dm = rawIn.match(/['"]subagent_type['"]\s*:\s*['"]([^'"]+)['"]/);
    const tm = rawIn.match(/['"]task_description['"]\s*:\s*(['"])([\s\S]*?)\1/);
    if (dm) subType = dm[1];
    if (tm) desc = tm[2];
    const result = unwrapToolData(a['gen_ai.tool.output']);
    const name = `${subType}-${i + 1}`.replace(/ /g, '-').replace(/#/g, '');
    const tsStart = toMs(ts.startNs), tsEnd = toMs(ts.endNs);
    coordTools.push({
      id: `${a['gen_ai.tool.id'] ?? ts.spanId}#${i}`, type: 'function',
      function: { name: 'task', arguments: JSON.stringify({ subagent_type: name, description: desc.slice(0, 1500) }) },
      state: 'success', output: result.slice(0, 1500), timing: { started_at: tsStart, completed_at: tsEnd },
    });
    subs.push({
      role: 'subagent', agent: name, subagent_name: name, subagent_session_id: `${taskId}_sub_${i + 1}`,
      content: result.slice(0, 1500), tool_calls: [], timeInfo: { created: tsStart, completed: tsEnd },
    });
  });

  const taskEnds = taskSpans.length ? taskSpans.map((t) => toMs(t.endNs)) : [toMs(last ?? 0)];
  const spawnDone = Math.max(...taskEnds);
  const interactions: any[] = [
    { role: 'user', content: query },
    { role: 'assistant', agent: 'coordinator', content: planContent && planContent !== mergeContent ? planContent : '',
      tool_calls: coordTools, timeInfo: { created: toMs(first ?? 0), completed: spawnDone } },
    ...subs,
    { role: 'assistant', agent: 'coordinator', content: final,
      usage: { input: inTok, output: outTok, total: totTok }, timeInfo: { created: spawnDone, completed: toMs(last ?? 0) } },
  ];
  return record({
    taskId, query, agentName: 'coordinator', agents: ['coordinator', ...subs.map((s) => s.subagent_name)],
    model, inTok, outTok, totTok, tools: taskSpans.length, llm, first, last, final, interactions, user,
    subagentCount: subs.length,
  });
}

// ---- shared record builder ----------------------------------------------

function record(p: {
  taskId: string; query: string; agentName: string; agents: string[]; model: string;
  inTok: number; outTok: number; totTok: number; tools: number; llm: number;
  first: number | null; last: number | null; final: string; interactions: any[]; user?: string; subagentCount: number;
}): ExecutionRecord {
  const latency = p.first ? (((p.last ?? 0) - p.first) / 1_000_000_000) : 0;
  const rec: ExecutionRecord = {
    task_id: p.taskId,
    query: p.query,
    framework: 'jiuwenswarm',
    agentName: p.agentName,
    agent: p.agentName,
    agents: p.agents,
    model: p.model || 'unknown',
    tokens: p.totTok,
    input_tokens: p.inTok,
    output_tokens: p.outTok,
    tool_call_count: p.tools,
    llm_call_count: p.llm,
    latency: Math.round(latency * 1000) / 1000,
    final_result: p.final,
    interactions: p.interactions,
    label: 'jiuwenswarm',
    subagentCount: p.subagentCount,
  } as ExecutionRecord;
  if (p.user) (rec as any).user = p.user;
  return rec;
}

/**
 * Build an ExecutionRecord from a decoded OTLP traces body emitted by jiuwen.
 * Returns null if no usable spans.
 */
export function aggregateJiuwenOtlp(body: any, opts: { user?: string } = {}): ExecutionRecord | null {
  return aggregateJiuwenOtlpFromSpans(collectJiuwenSpans(body), opts);
}

/** Same as aggregateJiuwenOtlp but from an already-collected (and possibly
 *  spool-accumulated across OTLP batches) span list. */
export function aggregateJiuwenOtlpFromSpans(spansIn: JiuwenSpan[], opts: { user?: string } = {}): ExecutionRecord | null {
  const spans = [...spansIn].sort((a, b) => a.startNs - b.startNs);
  if (!spans.length) return null;
  const taskId = sessionId(spans) || `jiuwen-${spans[0].traceId ?? 'run'}`;
  const query = String(spans.find((s) => s.attrs['gen_ai.prompt.1.content'])?.attrs['gen_ai.prompt.1.content'] ?? 'jiuwenswarm run');
  const user = opts.user;

  const hasTeam = spans.some((s) => s.name.startsWith('team.') || isAgentSpan(s));
  const hasTaskTool = spans.some((s) => s.name.startsWith('tool.task'));
  if (hasTeam) return transformTeam(spans, taskId, query, user);
  if (hasTaskTool) return transformTask(spans, taskId, query, user);
  return transformSingle(spans, taskId, query, user);
}
