import { classify, infraContextFor, type Classification } from '@/lib/infra/correlate';
import { groupSessionInfraTargets, getSessionLinks } from '@/lib/infra/sessions';
import type { ExecRef, InfraTarget } from '@/lib/infra/sessions';
import { querySamples } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';
import type { DiagnoseInputs, Finding, HardwareProfile, Verdict } from '@/lib/infra/types';

interface TreeExec {
  endpoint: string | null;
  model: string | null;
  startMs: number;
  endMs: number;
  outTokens: number;
}

export interface ExecutionInfraCard {
  endpoint: string;
  model: string | null;
  window: { startMs: number; endMs: number; latencyMs: number };
  correlated: boolean;
  sourceId: string | null;
  reason?: string;
  verdict: Verdict | null;
  bottleneck: string | null;
  samples: number;
  classification: Classification | null;
  findings: Finding[];
  metrics: Partial<DiagnoseInputs>;
}

export interface ExecutionInfraContext {
  correlated: boolean;
  rootExecutionId: string;
  manual: boolean;
  sessionWindow: { startMs: number; endMs: number } | null;
  reason?: string;
  endpoint?: string | null;
  cards: ExecutionInfraCard[];
}

export async function loadExecutionInfraTree(id: string): Promise<{ rootId: string; execs: TreeExec[] } | null> {
  const self = await prismaRaw.execution.findUnique({ where: { id }, select: { rootExecutionId: true } });
  if (!self) return null;
  const rootId = self.rootExecutionId || id;
  const rows = await prismaRaw.execution.findMany({
    where: { OR: [{ rootExecutionId: rootId }, { id: rootId }] },
    select: { endpoint: true, timestamp: true, latency: true, outputTokens: true, model: true },
  });
  const execs: TreeExec[] = rows.map((r) => {
    const endMs = r.timestamp.getTime();
    return {
      endpoint: r.endpoint ?? null,
      model: r.model ?? null,
      startMs: endMs - (r.latency ?? 0),
      endMs,
      outTokens: r.outputTokens ?? 0,
    };
  });
  return { rootId, execs };
}

function emptyMetrics(): Partial<DiagnoseInputs> {
  return {};
}

async function buildExecutionInfraCard(target: InfraTarget, execs: TreeExec[]): Promise<ExecutionInfraCard> {
  const source = await prismaRaw.infraSource.findUnique({ where: { endpoint: target.endpoint } });
  const base = {
    endpoint: target.endpoint,
    model: target.model,
    window: { startMs: target.startMs, endMs: target.endMs, latencyMs: target.endMs - target.startMs },
  };
  if (!source) {
    return {
      ...base,
      correlated: false,
      sourceId: null,
      reason: '该 endpoint 尚未注册为 infra 源',
      verdict: null,
      bottleneck: null,
      samples: 0,
      classification: null,
      findings: [],
      metrics: emptyMetrics(),
    };
  }

  const samples = await querySamples(source.id, target.startMs - 2000, target.endMs + 2000, target.model ?? undefined);
  const hw: HardwareProfile | undefined = source.memBandwidthGBs != null
    ? { name: source.hardwareName ?? 'custom', memBandwidthGBs: source.memBandwidthGBs }
    : undefined;
  const ctx = infraContextFor({ startMs: target.startMs, endMs: target.endMs }, samples, hw);
  const outTokens = execs
    .filter((e) => e.endpoint === target.endpoint && (target.model == null || e.model === target.model))
    .reduce((acc, e) => acc + e.outTokens, 0);
  const cls = classify({ startMs: target.startMs, endMs: target.endMs, latencyMs: target.endMs - target.startMs, outTokens }, ctx);

  return {
    ...base,
    correlated: !!ctx,
    sourceId: source.id,
    reason: ctx ? undefined : '该时间窗内无 infra 采样',
    verdict: ctx?.diag.verdict ?? null,
    bottleneck: ctx?.diag.bottleneck ?? null,
    samples: ctx?.samples ?? 0,
    classification: cls,
    findings: ctx?.diag.findings ?? [],
    metrics: ctx?.agg ?? emptyMetrics(),
  };
}

export async function buildExecutionInfraContext(executionId: string): Promise<ExecutionInfraContext | null> {
  const tree = await loadExecutionInfraTree(executionId);
  if (!tree) return null;

  const { rootId, execs } = tree;
  const withEndpoint = execs.filter((e) => e.endpoint);
  const sessionWindow = withEndpoint.length
    ? { startMs: Math.min(...withEndpoint.map((e) => e.startMs)), endMs: Math.max(...withEndpoint.map((e) => e.endMs)) }
    : null;
  const fullWindow = execs.length
    ? { startMs: Math.min(...execs.map((e) => e.startMs)), endMs: Math.max(...execs.map((e) => e.endMs)) }
    : null;

  const manualLinks = await getSessionLinks(rootId);
  let targets: InfraTarget[];
  if (manualLinks.length > 0 && fullWindow) {
    const sources = await prismaRaw.infraSource.findMany({
      where: { id: { in: manualLinks.map((l) => l.sourceId) } },
      select: { id: true, endpoint: true },
    });
    const endpointById = new Map(sources.map((source) => [source.id, source.endpoint]));
    targets = manualLinks
      .map((link) => ({ endpoint: endpointById.get(link.sourceId), model: link.model, startMs: fullWindow.startMs, endMs: fullWindow.endMs }))
      .filter((target): target is InfraTarget => Boolean(target.endpoint));
  } else {
    targets = groupSessionInfraTargets(execs as ExecRef[]);
  }

  const cards = await Promise.all(targets.map((target) => buildExecutionInfraCard(target, execs)));
  return {
    correlated: cards.some((card) => card.correlated),
    rootExecutionId: rootId,
    manual: manualLinks.length > 0,
    sessionWindow,
    reason: cards.length === 0 ? (sessionWindow ? '该 session 的推理源尚未注册为 infra 源' : 'session 无 endpoint（未采到真实推理源 URL）') : undefined,
    endpoint: withEndpoint[0]?.endpoint,
    cards,
  };
}

const f = (value: number | null | undefined, digits = 2): string => value == null ? 'n/a' : value.toFixed(digits);

export function summarizeExecutionInfraForDiagnosis(context: ExecutionInfraContext | null): string {
  if (!context) return '推理 Infra 观测指标：execution 不存在，无法关联。';
  if (context.cards.length === 0) return `推理 Infra 观测指标：未关联到 infra 源。原因：${context.reason || '无可用 endpoint'}`;

  const lines = [
    '推理 Infra 观测指标（按 session execution tree 的推理源时间窗关联）：',
    `- rootExecutionId=${context.rootExecutionId} correlated=${context.correlated ? 'yes' : 'no'} manualOverride=${context.manual ? 'yes' : 'no'}`,
  ];
  context.cards.forEach((card, index) => {
    const metrics = card.metrics;
    const classification = card.classification;
    lines.push(
      `- card#${index + 1} endpoint=${card.endpoint} model=${card.model || 'unknown'} window=${card.window.latencyMs}ms samples=${card.samples} correlated=${card.correlated ? 'yes' : 'no'}`,
      `  verdict=${card.verdict || 'n/a'} bottleneck=${card.bottleneck || 'n/a'} classification=${classification?.label || 'n/a'} why=${classification?.why || card.reason || 'n/a'}`,
      `  metrics: running_peak=${f(metrics.runningPeak, 0)} waiting_peak=${f(metrics.waitingPeak, 0)} kv_peak=${f(metrics.kvPeakPerc, 1)}% preempt_rate=${f(metrics.preemptRate, 2)}/s gen_tok_s=${f(metrics.genTokPerS, 1)} prompt_tok_s=${f(metrics.promptTokPerS, 1)}`,
      `  latency: ttft_p95=${f(metrics.ttftP95)}s queue_p95=${f(metrics.queueP95)}s prefill_p95=${f(metrics.prefillP95)}s itl_p95=${f(metrics.itlP95, 3)}s tpot_p95=${f(metrics.tpotP95, 3)}s e2e_p95=${f(metrics.e2eP95)}s`,
    );
    for (const finding of card.findings.slice(0, 4)) {
      lines.push(`  finding: [${finding.sev}/${finding.cls}] ${finding.title}; evidence=${finding.evidence}; diagnosis=${finding.diagnosis}`);
    }
  });
  return lines.join('\n');
}
