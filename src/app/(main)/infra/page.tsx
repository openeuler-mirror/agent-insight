'use client';

import { useCallback, useEffect, useState } from 'react';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { reportClientUsage } from '@/lib/usage-analytics/client-events';

interface Finding { sev: 'critical' | 'warn' | 'healthy' | 'info'; cls: string; title: string; evidence: string; diagnosis: string; remediation: string[]; }
interface Sli { runningPeak: number; waitingPeak: number; kvPeakPerc: number; genTokPerS: number; ttftP95: number | null; itlP95: number | null; prefixHit: number | null; preemptRate: number; }
interface Summary { target: string; model: string | null; verdict: string; bottleneck: string; slis: Sli; findings: Finding[]; samples: number; tsMs: number; }
interface OverviewItem {
  source: { id: string; endpoint: string; kind: string; model: string | null; scrapeIntervalMs: number; enabled: boolean };
  hasData: boolean; lastSampleMs: number | null; verdict: string | null; bottleneck: string | null; slis: Sli | null;
  models?: string[]; primaryModel?: string | null; stalePush?: boolean;
}

const VERDICT_TONE: Record<string, { fg: string; bg: string; border: string; label: string }> = {
  critical: { fg: 'var(--error)', bg: 'var(--error-subtle)', border: 'var(--error)', label: '严重' },
  degraded: { fg: 'var(--warning)', bg: 'var(--warning-subtle)', border: 'var(--warning-subtle-border)', label: '降级' },
  healthy: { fg: 'var(--success)', bg: 'var(--success-subtle)', border: 'var(--success-subtle-border)', label: '健康' },
  idle: { fg: 'var(--foreground-muted)', bg: 'var(--background-secondary)', border: 'var(--border)', label: '空载' },
};
const SEV_COLOR: Record<string, string> = { critical: 'var(--error)', warn: 'var(--warning)', healthy: 'var(--success)', info: 'var(--foreground-muted)' };
const DOT: Record<string, string> = { critical: 'var(--error)', degraded: 'var(--warning)', healthy: 'var(--success)', idle: 'var(--foreground-muted)' };
function fmt(n: number | null | undefined, d = 2, s = '') { return n == null ? 'n/a' : `${n.toFixed(d)}${s}`; }

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 60 }}>
      <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

// 概览卡：纯摘要，点开进单源详情页（趋势/诊断/配置都在详情页）。
function OverviewCard({ it }: { it: OverviewItem }) {
  // push 源若最近没新样本 = collector 没在推（服务端算好），别拿旧数据冒充"实时"
  const stalePush = !!it.stalePush;
  const tone = !stalePush && it.verdict ? VERDICT_TONE[it.verdict] : null;
  return (
    <a
      href={`/infra/source/${encodeURIComponent(it.source.id)}`}
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, transition: 'border-color 0.12s' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 9, height: 9, borderRadius: 999, background: DOT[it.verdict ?? 'idle'] ?? 'var(--foreground-muted)', flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>{it.source.endpoint}</span>
          <span style={{ flex: 1 }} />
          {tone && (
            <span style={{ fontSize: 11.5, fontWeight: 600, color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 999, padding: '2px 9px' }}>
              {tone.label}{it.bottleneck && it.bottleneck !== 'none' ? ` · ${it.bottleneck}` : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--foreground-muted)', marginTop: -4 }}>
          {(it.models && it.models.length > 1) ? `${it.models.length} 个模型` : (it.primaryModel ?? it.source.model ?? 'model n/a')} · {it.source.kind === 'pull' ? `主动拉取 · ${(it.source.scrapeIntervalMs / 1000).toFixed(0)}s` : 'Collector 推送'}{!it.source.enabled ? ' · 已停用' : ''}
        </div>

        {stalePush ? (
          <div style={{ fontSize: 12.5, color: 'var(--warning)' }}>⏳ 等待 collector 推送（尚未收到/已停）—— 点开按配置启动 collector</div>
        ) : it.hasData && it.slis ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '4px 0' }}>
            <Chip label="并发" value={String(it.slis.runningPeak)} />
            <Chip label="KV" value={fmt(it.slis.kvPeakPerc, 1, '%')} />
            <Chip label="gen/s" value={fmt(it.slis.genTokPerS, 0)} />
            <Chip label="TTFT p95" value={fmt(it.slis.ttftP95, 2, 's')} />
            <Chip label="ITL p95" value={it.slis.itlP95 == null ? 'n/a' : fmt(it.slis.itlP95 * 1000, 0, 'ms')} />
            <Chip label="Prefix" value={it.slis.prefixHit == null ? 'n/a' : fmt(it.slis.prefixHit * 100, 0, '%')} />
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>暂无采样（自动拉取攒一会，或在源管理点「立即拉取一轮」）</div>
        )}

        <div style={{ fontSize: 12.5, color: 'var(--primary)', borderTop: '1px solid var(--border)', paddingTop: 9 }}>查看详情 / 趋势 / 配置 →</div>
      </div>
    </a>
  );
}

export default function InfraPage() {
  const [overview, setOverview] = useState<OverviewItem[]>([]);
  const [target, setTarget] = useState('');
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    const res = await fetch('/api/observe/infra/sources/overview', { cache: 'no-store' });
    const body = await res.json();
    setOverview(body.overview ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      await loadOverview();
      if (!active) return;
      const t = new URLSearchParams(window.location.search).get('target');
      if (t) setTarget(t);
    })();
    // 从源管理删除后「后退」回来时，页面常从 bfcache 恢复、挂载 fetch 不重跑 → 列表是旧的。
    // 监听 pageshow（bfcache 恢复）/ visibilitychange（切回标签）重新拉一次，免手动 F5。
    const onShow = () => { void loadOverview(); };
    const onVis = () => { if (document.visibilityState === 'visible') void loadOverview(); };
    window.addEventListener('pageshow', onShow);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      active = false;
      window.removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [loadOverview]);

  const run = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/observe/infra/diagnose?target=${encodeURIComponent(target)}&samples=1`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      setData(body as Summary);
      reportClientUsage('infra', 'infra.diagnose');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [target]);

  const tone = data ? VERDICT_TONE[data.verdict] ?? VERDICT_TONE.idle : null;

  return (
    <>
      <AppTopBar title="推理 Infra 观测" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24, color: 'var(--foreground)' }}>
        {/* 临时诊断（任意 URL，无需注册）置顶 */}
        <h3 style={{ margin: '0 0 4px' }}>临时诊断</h3>
        <div style={{ fontSize: 12.5, color: 'var(--foreground-muted)', marginBottom: 10 }}>对任意 vLLM 源即时拉一次诊断（不落库、不影响已接入源）。要持续观测请到下方「已接入源」。</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, maxWidth: 720 }}>
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="http://host:8000"
            style={{ flex: 1, padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)' }} />
          <button onClick={run} disabled={loading}
            style={{ padding: '8px 18px', borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer', background: 'var(--primary)', color: 'var(--primary-foreground)', opacity: loading ? 0.6 : 1 }}>
            {loading ? '诊断中…' : '诊断'}
          </button>
        </div>

        {error && <div style={{ color: 'var(--error)', marginBottom: 16 }}>拉取失败：{error}</div>}

        {data && tone && (
          <div style={{ maxWidth: 920, marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', marginBottom: 14, borderRadius: 'var(--radius-lg)', background: tone.bg, border: `1px solid ${tone.border}` }}>
              <span style={{ fontSize: 20, fontWeight: 700, color: tone.fg }}>{tone.label}</span>
              <span style={{ color: 'var(--foreground-secondary)' }}>主瓶颈：<b>{data.bottleneck}</b> · model：{data.model ?? 'n/a'} · 源：{data.target}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {data.findings.map((f, i) => (
                <div key={i} style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderLeft: `4px solid ${SEV_COLOR[f.sev] ?? 'var(--border)'}` }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}><span style={{ color: SEV_COLOR[f.sev], marginRight: 6 }}>●</span>[{f.cls}] {f.title}</div>
                  <div style={{ fontSize: 13, color: 'var(--foreground-muted)', marginBottom: 4 }}>证据：{f.evidence}</div>
                  <div style={{ fontSize: 13, color: 'var(--foreground-secondary)' }}>{f.diagnosis}</div>
                  {f.remediation.length > 0 && <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--foreground-secondary)' }}>{f.remediation.map((r, j) => <li key={j}>{r}</li>)}</ul>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 已接入源 */}
        <div style={{ display: 'flex', alignItems: 'center', margin: '8px 0 12px' }}>
          <h3 style={{ margin: 0 }}>已接入源（{overview.length}）</h3>
          <span style={{ flex: 1 }} />
          <a href="/infra/sources" style={{ color: 'var(--primary)', fontSize: 13 }}>源管理 / 添加 →</a>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
          {overview.length === 0 && <div style={{ color: 'var(--foreground-muted)' }}>还没有接入源。到 <a href="/infra/sources" style={{ color: 'var(--primary)' }}>源管理</a> 添加或自动发现。</div>}
          {overview.map((it) => <OverviewCard key={it.source.id} it={it} />)}
        </div>
      </div>
    </>
  );
}
