// Session↔Infra 关联（方式①：时间窗 join）。把一次调用的时间窗对齐到该源的 infra 采样，
// 复用诊断内核得 infra 上下文，再判定延迟主因在底层(INFRA-BOUND)/固有(INHERENT)/agent 侧(APP-BOUND)。
// 在 spike 06 真机验证：误差<0.3%；同一 session 落到受压窗口会翻转为 INFRA-BOUND。

import { aggregate, diagnose } from '@/lib/infra/diagnose';
import type { DiagnoseInputs, DiagnoseResult, HardwareProfile, InfraMetricSample } from '@/lib/infra/types';

export type CorrelationLabel = 'INFRA-BOUND' | 'INHERENT' | 'APP-BOUND' | 'unknown';

export interface CallWindow {
  startMs: number;
  endMs: number;
  latencyMs: number;
  outTokens: number;
}

export interface InfraContext {
  agg: DiagnoseInputs;
  diag: DiagnoseResult;
  samples: number;
}

export interface Classification {
  label: CorrelationLabel;
  why: string;
}

/** 时间窗 join：取命中该调用窗口（±1s 容差）的 infra 采样 → 聚合 + 诊断。无样本返回 null。 */
export function infraContextFor(
  window: { startMs: number; endMs: number },
  series: InfraMetricSample[],
  hw?: HardwareProfile,
): InfraContext | null {
  const win = series.filter((s) => s.tsMs >= window.startMs - 1000 && s.tsMs <= window.endMs + 1000);
  if (win.length === 0) return null;
  const agg = aggregate(win);
  const diag = diagnose(agg, hw);
  return { agg, diag, samples: win.length };
}

const f2 = (x: number | null | undefined, d = 2): string => (x == null ? 'n/a' : x.toFixed(d));

/** 判定这次调用的延迟主因。 */
export function classify(call: CallWindow, ctx: InfraContext | null): Classification {
  if (!ctx) return { label: 'unknown', why: '窗口内无 infra 采样，无法关联' };
  const d = ctx.diag;
  const a = ctx.agg;

  const infraBad =
    d.bottleneck === 'queue' ||
    d.bottleneck === 'kv' ||
    a.preemptRate > 0 ||
    (a.queueP95 != null && a.queueP95 > 0.5);

  // 固有 decode 耗时 ≈ outTokens × 健康 TPOT + prefill
  const tpot = a.itlAvg ?? a.tpotP95 ?? 0.04;
  const inherentMs = (call.outTokens || 0) * tpot * 1000 + (a.prefillAvg ?? 0.2) * 1000;
  const ratio = call.latencyMs / Math.max(1, inherentMs);

  if (infraBad) {
    return {
      label: 'INFRA-BOUND',
      why: `窗口内 infra ${d.verdict}/${d.bottleneck}（queue_p95=${f2(a.queueP95)}s preempt=${a.preemptRate.toFixed(1)}/s）→ 延迟主因在底层`,
    };
  }
  if (ratio <= 1.6) {
    return {
      label: 'INHERENT',
      why: `infra 健康；延迟≈输出长度×TPOT（${call.outTokens}tok×${(tpot * 1000).toFixed(0)}ms≈${Math.round(inherentMs)}ms，实际${call.latencyMs}ms）→ 非 infra 问题`,
    };
  }
  return {
    label: 'APP-BOUND',
    why: `infra 健康但延迟是固有耗时的 ${ratio.toFixed(1)}× → 慢在 agent 侧（工具/重试/客户端排队）`,
  };
}
