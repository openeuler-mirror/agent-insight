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

// ---- main-agent naming ---------------------------------------------------
// Mirror of the hermes adapter's displayHermesAgentName (PR !146 "适配自定义主agent"):
// the main/root agent shown for a trace must be the agent's *real* configured name,
// not a baked-in placeholder. Blank → undefined (caller falls back), the sentinel
// "default" → the framework label, otherwise the configured name verbatim.
const JIUWEN_FRAMEWORK = 'jiuwenswarm';

function displayJiuwenAgentName(value: unknown, framework: string = JIUWEN_FRAMEWORK): string | undefined {
  const name = String(value ?? '').trim();
  if (!name) return undefined;
  if (name.toLowerCase() === 'default') return framework;
  return name;
}

// ---- task content (the "任务内容" column = ExecutionRecord.query) ------------
// jiuwen's prompt telemetry varies by topology and inbound channel; deriving the
// user request from a single hardcoded attribute produced three different displays
// for the same onboarding (raw user text / a leaked envelope / a "jiuwenswarm run"
// placeholder). extractQuery normalizes both axes: where the prompt lives, and how
// the channel wrapped it.

/**
 * The user request shown as a trace's task content. Robust across jiuwen's
 * prompt shapes: prefer a role=user prompt when roles are stamped, else fall back
 * .1 → .0 (the old code hardcoded `gen_ai.prompt.1.content`, so runs with the user
 * turn at .0 — no system message — degraded to the useless "jiuwenswarm run"
 * placeholder). The chosen content is then unwrapped (see unwrapUserMessage).
 */
function extractQuery(spans: JiuwenSpan[]): string {
  const llmFirst = spans.filter(isLlm).sort((a, b) => a.startNs - b.startNs);
  for (const s of [...llmFirst, ...spans]) {
    const content = userPromptContent(s.attrs);
    if (content) return unwrapUserMessage(content);
  }
  return `${JIUWEN_FRAMEWORK} run`;
}

/** Concatenated `role=system` prompt content from one span's `gen_ai.prompt.*`
 *  attrs. jiuwen stamps the system turn at index .0 (see configure_prompt_template);
 *  '' when the span carries no system turn. */
function systemPromptContent(attrs: Record<string, unknown>): string {
  const out: string[] = [];
  for (let n = 0; n < 32; n++) {
    const content = attrs[`gen_ai.prompt.${n}.content`];
    if (content == null) continue;
    if (String(attrs[`gen_ai.prompt.${n}.role`] ?? '').toLowerCase() === 'system') {
      const text = String(content);
      if (text.trim()) out.push(text);
    }
  }
  return out.join('\n\n');
}

/** First non-empty system prompt across the run's llm.call spans. The system turn
 *  is identical on every call of an agent, so one entry is enough; the trace builder
 *  dedups and stashes it on the agent node. '' when no span carries a system turn. */
function firstSystemPrompt(spans: JiuwenSpan[]): string {
  for (const s of spans) {
    if (!isLlm(s)) continue;
    const sys = systemPromptContent(s.attrs);
    if (sys) return sys;
  }
  return '';
}

/** Opening interactions for a run: the root agent's system prompt (when present,
 *  `role:'system'` so the trace builder stashes it on the node) followed by the user
 *  turn. Subagent-specific system prompts are a follow-up; here we surface the root. */
function leadInteractions(query: string, sys: string, agent: string): any[] {
  const head: any[] = [];
  if (sys) head.push({ role: 'system', content: sys, agent, system_prompt_length: sys.length });
  head.push({ role: 'user', content: query });
  return head;
}

/** First user-turn prompt content from one span's `gen_ai.prompt.*` attrs —
 *  role-aware, with an index fallback for spans that don't stamp roles. '' if none. */
function userPromptContent(attrs: Record<string, unknown>): string {
  const at = (n: number): string | undefined => {
    const v = attrs[`gen_ai.prompt.${n}.content`];
    return v == null ? undefined : String(v);
  };
  for (let n = 0; n < 32; n++) {
    if (at(n) === undefined) continue;
    if (String(attrs[`gen_ai.prompt.${n}.role`] ?? '').toLowerCase() === 'user') return at(n)!;
  }
  // No roles stamped → skip a likely system prompt at .0: prefer .1, then .0.
  return at(1) ?? at(0) ?? '';
}

/**
 * jiuwen's ACP / metadata channels wrap the user turn as
 * `你收到一条消息：{ … "type":"user input", "content":"<real text>" … }` and send it
 * verbatim to the LLM, so the envelope lands in `gen_ai.prompt.*.content`. Show the
 * human's actual `.content` instead. Only unwraps when the envelope markers are
 * present, and tolerates truncated JSON (team payloads can be cut ~2000 chars) via a
 * best-effort content regex. Anything unrecognized passes through untouched.
 */
function unwrapUserMessage(raw: string): string {
  const s = String(raw ?? '').trim();
  const brace = s.indexOf('{');
  if (brace < 0) return s;
  const json = s.slice(brace);
  const looksLikeEnvelope =
    (json.includes('"type"') && json.includes('user input')) ||
    (json.includes('"source"') && json.includes('acp'));
  if (!looksLikeEnvelope) return s;
  try {
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object' && typeof obj.content === 'string' && obj.content.trim()) {
      return obj.content.trim();
    }
  } catch {
    const m = json.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (m) {
      try { return String(JSON.parse(`"${m[1]}"`)).trim() || s; } catch { return m[1]; }
    }
  }
  return s;
}

/**
 * Main-agent name for a single-agent (run_agent / ReAct) run. agent-core only stamps
 * the agent card name onto the `agent.<member>.task_iteration` boundary spans that
 * *team* runs emit (carrying agentteam.agent.*); a bare single run emits only
 * llm.call / tool.* spans, so there is usually no per-agent name to recover and we
 * fall back to the framework label "jiuwenswarm". When a name attribute IS present we
 * honor it — that is what "适配自定义主agent" means here. The previous port hardcoded a
 * spike's "jiuwenswarm/spike_agent", which then showed up as the agent of every
 * single-agent jiuwen trace regardless of the real agent.
 */
function singleAgentName(spans: JiuwenSpan[]): string {
  for (const s of spans) {
    const name =
      displayJiuwenAgentName(s.attrs['agentteam.agent.name']) ??
      displayJiuwenAgentName(s.attrs['gen_ai.agent.name']);
    if (name) return name;
  }
  return JIUWEN_FRAMEWORK;
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
  const agentName = singleAgentName(spans);
  const interactions: any[] = leadInteractions(query, firstSystemPrompt(spans), agentName);
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
      usage: { input: pt, output: ct, total: tt }, modelID: model, agent: agentName,
      timeInfo: { created: toMs(s.startNs), completed: toMs(s.endNs) },
    });
  }
  return record({
    taskId, query, agentName, agents: [agentName],
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

  const interactions: any[] = leadInteractions(query, firstSystemPrompt(spans), leader);
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
  const sorted = [...spans].sort((a, b) => a.startNs - b.startNs);
  let inTok = 0, outTok = 0, totTok = 0, llm = 0, toolCount = 0, model = '', final = '';
  let first: number | null = null, last: number | null = null;
  let subIdx = 0;
  const subNames: string[] = [];

  // A coordinator tool span (non-task) -> a tool_call carrying FULL input/output.
  const toToolCall = (s: JiuwenSpan) => {
    const a = s.attrs;
    return {
      id: String(a['gen_ai.tool.id'] ?? s.spanId), type: 'function',
      function: {
        name: String(a['gen_ai.tool.name'] ?? s.name.split('.').slice(1).join('.')),
        arguments: String(a['gen_ai.tool.input'] ?? ''),
      },
      state: 'success', output: unwrapToolData(a['gen_ai.tool.output']),
      timing: { started_at: toMs(s.startNs), completed_at: toMs(s.endNs) },
    };
  };

  // Walk spans in time order. Each llm.call opens its OWN coordinator turn carrying its OWN
  // usage, so per-step tokens show in the timeline instead of being lumped onto one wrap-up
  // turn; the tool spans that follow attach to that turn (jiuwen tool spans have no parent
  // link, so association is by time). Task spawns additionally emit a subagent turn. Ordering
  // (e.g. a skill read after the subagents return but before the final answer) falls out of
  // the time walk for free.
  const interactions: any[] = leadInteractions(query, firstSystemPrompt(sorted), 'coordinator');
  let curLlm: any = null;
  const coordTurnFor = (s: JiuwenSpan) => {
    if (curLlm) return curLlm;
    // tool before any llm.call (rare) — open a usage-less coordinator turn so it isn't lost
    curLlm = { role: 'assistant', agent: 'coordinator', content: '', tool_calls: [],
      timeInfo: { created: toMs(s.startNs), completed: toMs(s.startNs) } };
    interactions.push(curLlm);
    return curLlm;
  };

  for (const s of sorted) {
    first = first === null ? s.startNs : Math.min(first, s.startNs);
    last = last === null ? s.endNs : Math.max(last, s.endNs);
    const a = s.attrs;
    if (isLlm(s)) {
      llm++;
      const pt = Number(a['gen_ai.usage.prompt_tokens'] || 0);
      const ct = Number(a['gen_ai.usage.completion_tokens'] || 0);
      const tt = Number(a['gen_ai.usage.total_tokens'] || pt + ct);
      inTok += pt; outTok += ct; totTok += tt;
      model = String(a['gen_ai.request.model'] || model);
      const c = completion(a);
      if (c) final = c;
      curLlm = {
        role: 'assistant', agent: 'coordinator', content: c,
        usage: { input: pt, output: ct, total: tt }, modelID: String(a['gen_ai.request.model'] || ''),
        tool_calls: [], timeInfo: { created: toMs(s.startNs), completed: toMs(s.endNs) },
      };
      interactions.push(curLlm);
    } else if (s.name.startsWith('tool.task')) {
      toolCount++;
      subIdx++;
      const rawIn = String(a['gen_ai.tool.input'] ?? '');
      let desc = rawIn, subType = 'general-purpose';
      const dm = rawIn.match(/['"]subagent_type['"]\s*:\s*['"]([^'"]+)['"]/);
      const tm = rawIn.match(/['"]task_description['"]\s*:\s*(['"])([\s\S]*?)\1/);
      if (dm) subType = dm[1];
      if (tm) desc = tm[2];
      const result = unwrapToolData(a['gen_ai.tool.output']);
      const name = `${subType}-${subIdx}`.replace(/ /g, '-').replace(/#/g, '');
      subNames.push(name);
      const tsStart = toMs(s.startNs), tsEnd = toMs(s.endNs);
      // spawn rendered as a `task` tool_call on the spawning coordinator turn ...
      coordTurnFor(s).tool_calls.push({
        id: `${a['gen_ai.tool.id'] ?? s.spanId}#${subIdx}`, type: 'function',
        function: { name: 'task', arguments: JSON.stringify({ subagent_type: name, description: desc.slice(0, 1500) }) },
        state: 'success', output: result.slice(0, 1500), timing: { started_at: tsStart, completed_at: tsEnd },
      });
      // ... and the subagent result as its own subagent turn right after.
      interactions.push({
        role: 'subagent', agent: name, subagent_name: name, subagent_session_id: `${taskId}_sub_${subIdx}`,
        content: result.slice(0, 1500), tool_calls: [], timeInfo: { created: tsStart, completed: tsEnd },
      });
    } else if (isTool(s)) {
      toolCount++;
      coordTurnFor(s).tool_calls.push(toToolCall(s));
    }
  }

  return record({
    taskId, query, agentName: 'coordinator', agents: ['coordinator', ...subNames],
    model, inTok, outTok, totTok, tools: toolCount, llm, first, last, final, interactions, user,
    subagentCount: subIdx,
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

/**
 * The team-run root span (`team.<name>`), once it has ended. agent-core creates it
 * with no parent and EXCLUDES it from forced span cleanup, so it is closed only when
 * the whole team run finishes and is therefore exported in the final OTLP batch. Its
 * presence in the spool is an explicit "this run is done" signal — we key
 * `trace_completed_at` off its end time. `team.<name>` only matches the root span
 * (tool spans are `tool.*`; tool *ids* like `team.create_task` are attributes, not span
 * names), so there is no collision. Single-agent (`run_agent`/ReAct) runs emit no such
 * span; their completion is inferred read-side from a quiet window instead.
 */
function endedTeamRootSpan(spans: JiuwenSpan[]): JiuwenSpan | undefined {
  return spans
    .filter((s) => s.name.startsWith('team.') && s.endNs > 0)
    .reduce<JiuwenSpan | undefined>((latest, s) => (!latest || s.endNs > latest.endNs ? s : latest), undefined);
}

/** Same as aggregateJiuwenOtlp but from an already-collected (and possibly
 *  spool-accumulated across OTLP batches) span list. */
export function aggregateJiuwenOtlpFromSpans(spansIn: JiuwenSpan[], opts: { user?: string } = {}): ExecutionRecord | null {
  const spans = [...spansIn].sort((a, b) => a.startNs - b.startNs);
  if (!spans.length) return null;
  const query = extractQuery(spans);
  const user = opts.user;

  const hasTeam = spans.some((s) => s.name.startsWith('team.') || isAgentSpan(s));
  const hasTaskTool = spans.some((s) => s.name.startsWith('tool.task'));
  // Single-agent runs reuse a process-wide session id (e.g. the ACP CLI's fixed
  // "acp_cli_session"), so grouping single runs by session id would merge separate
  // invocations into one trace. They are single-trace, so key them by traceId
  // (unique per run). Only multi-trace team / fan-out runs — which genuinely need
  // the session id to stitch their spans across trace ids — use the session id.
  const traceTaskId = `jiuwen-${spans[0].traceId ?? 'run'}`;
  const taskId = (hasTeam || hasTaskTool) ? (sessionId(spans) || traceTaskId) : traceTaskId;

  const rec = hasTeam
    ? transformTeam(spans, taskId, query, user)
    : hasTaskTool
      ? transformTask(spans, taskId, query, user)
      : transformSingle(spans, taskId, query, user);

  // Explicit trace-completion signal for team runs: the `team.<name>` root span ends
  // last, so once it lands we mark the trace complete. saveExecutionRecord turns this
  // into Session.endTime, flipping the 列表/详情 status from "执行中" to "成功". Single-agent
  // runs have no root span → left undefined, handled by the read-side quiet-window rule.
  if (rec) {
    const teamRoot = endedTeamRootSpan(spans);
    if (teamRoot) rec.trace_completed_at = new Date(toMs(teamRoot.endNs)).toISOString();
  }
  return rec;
}
