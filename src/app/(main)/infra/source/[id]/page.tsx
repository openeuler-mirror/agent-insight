'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { reportClientUsage } from '@/lib/usage-analytics/client-events';
interface Finding { sev: 'critical' | 'warn' | 'healthy' | 'info'; cls: string; title: string; evidence: string; diagnosis: string; remediation: string[]; }
interface Sli { runningPeak: number; waitingPeak: number; kvPeakPerc: number; genTokPerS: number; ttftP95: number | null; itlP95: number | null; prefixHit: number | null; preemptRate: number; }
interface SourceObj { id: string; endpoint: string; scrapeUrl: string; kind: string; model: string | null; hardwareName: string | null; memBandwidthGBs: number | null; scrapeIntervalMs: number; enabled: boolean; }
interface OverviewItem { source: SourceObj; hasData: boolean; verdict: string | null; bottleneck: string | null; slis: Sli | null; models: string[]; primaryModel: string | null; }
interface Summary { target: string; model: string | null; verdict: string; bottleneck: string; slis: Sli; findings: Finding[]; samples: number; tsMs: number; }
interface HistoryPoint {
  tsMs: number; running: number; waiting: number; waitingCapacity: number; waitingDeferred: number;
  kvPerc: number; prefixHitPerc: number | null; genTokPerS: number; promptTokPerS: number;
  ttftP95: number | null; queueP95: number | null; prefillP95: number | null;
  itlP95Ms: number | null; tpotP95Ms: number | null; e2eP95: number | null; preemptRate: number;
}
interface SessionRow { id: string; taskId: string | null; tsMs: number; latencyMs: number | null; model: string | null; outputTokens: number | null; agentName: string | null; }
const VERDICT_TONE: Record<string, { fg: string; bg: string; border: string; label: string }> = {
  critical: { fg: 'var(--error)', bg: 'var(--error-subtle)', border: 'var(--error-subtle-border)', label: '严重' },
  degraded: { fg: 'var(--warning)', bg: 'var(--warning-subtle)', border: 'var(--warning-subtle-border)', label: '降级' },
  healthy: { fg: 'var(--success)', bg: 'var(--success-subtle)', border: 'var(--success-subtle-border)', label: '健康' },
  idle: { fg: 'var(--foreground-muted)', bg: 'var(--background-secondary)', border: 'var(--border)', label: '空载' },
};
const SEV_COLOR: Record<string, string> = { critical: 'var(--error)', warn: 'var(--warning)', healthy: 'var(--success)', info: 'var(--foreground-muted)' };
const field = { padding: '5px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: 13 } as const;
function fmt(n: number | null | undefined, d = 2, s = '') { return n == null ? 'n/a' : `${n.toFixed(d)}${s}`; }
function hhmmss(ms: number) { const dt = new Date(ms); return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`; }
// 纵轴刻度：压到最多 4~5 个字符（1200 → 1.2k，0.035 → 0.04），避免长数字被轴宽截断。
function yTick(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 10_000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${Number((v / 1000).toFixed(1))}k`;
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return String(Number(v.toFixed(1)));
  return String(Number(v.toFixed(2)));
}
const RANGES: { key: string; label: string; ms: number }[] = [
  { key: '5m', label: '5 分钟', ms: 5 * 60_000 },
  { key: '15m', label: '15 分钟', ms: 15 * 60_000 },
  { key: '1h', label: '1 小时', ms: 60 * 60_000 },
  { key: '6h', label: '6 小时', ms: 6 * 60 * 60_000 },
  { key: '24h', label: '24 小时', ms: 24 * 60 * 60_000 },
];
function collectorYaml(endpoint: string, ingestUrl: string, scrapeSec: number): string {
  let host = endpoint;
  try { host = new URL(endpoint).host; } catch { /* keep */ }
  const timeoutSec = Math.max(1, scrapeSec - 1);
  return [
    'receivers:', '  prometheus:', '    config:', '      scrape_configs:',
    '        - job_name: vllm',
    `          scrape_interval: ${scrapeSec}s`,
    `          scrape_timeout: ${timeoutSec}s`,
    '          static_configs:',
    `            - targets: ['${host}']`,
    'exporters:', '  otlphttp:', `    metrics_endpoint: ${ingestUrl}`,
    'service:', '  pipelines:', '    metrics:', '      receivers: [prometheus]', '      exporters: [otlphttp]',
  ].join('\n');
}
function Card({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
      <div style={{ fontSize: 12, color: 'var(--foreground-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = () => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setShow(true);
  };
  // 延迟关闭：给鼠标从图标跨到弹层（中间有空隙）的时间，否则一离开图标就消失，没法选里面的字
  const scheduleHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShow(false), 180);
  };
  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={open}
      onMouseLeave={scheduleHide}
    >
      <span style={{ cursor: 'help', color: 'var(--foreground-muted)', border: '1px solid var(--border)', borderRadius: 999, width: 13, height: 13, fontSize: 9, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>i</span>
      {show && (
        <span
          onMouseEnter={open}
          onMouseLeave={scheduleHide}
          style={{ position: 'absolute', bottom: '100%', left: -8, zIndex: 20, width: 248, paddingBottom: 8 /* 透明桥，覆盖图标与弹层之间的空隙 */ }}
        >
          <span style={{ display: 'block', padding: '8px 10px', background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11.5, lineHeight: 1.65, color: 'var(--foreground-secondary)', boxShadow: '0 6px 16px rgba(0,0,0,0.18)', whiteSpace: 'normal', fontWeight: 400, userSelect: 'text', cursor: 'text' }}>
            {text}
          </span>
        </span>
      )}
    </span>
  );
}
function MiniChart({ title, explain, data, series, yDomain }: { title: string; explain?: string; data: HistoryPoint[]; series: { key: keyof HistoryPoint; name: string; color: string }[]; yDomain?: [number, number] }) {
  return (
    <div style={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 10px' }}>
      <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
        {title}{explain && <InfoTip text={explain} />}
      </div>
      <div style={{ width: '100%', height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* left 不能给负值：负 margin 会把 YAxis 的刻度文字挤出 SVG 视窗左边被裁掉，
              1200 这种数只剩尾部两位显示成 "00"。轴宽由 YAxis width 控制，margin 保持 0。 */}
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="tsMs" tickFormatter={hhmmss} stroke="var(--foreground-muted)" tick={{ fontSize: 9 }} interval="preserveStartEnd" minTickGap={40} />
            <YAxis stroke="var(--foreground-muted)" tick={{ fontSize: 9 }} tickFormatter={yTick} width={38} domain={yDomain ?? [0, 'auto']} />
            <Tooltip labelFormatter={(v) => hhmmss(Number(v))} contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }} />
            {series.map((s) => <Line key={String(s.key)} type="monotone" dataKey={s.key as string} name={s.name} stroke={s.color} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
export default function InfraSourceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [item, setItem] = useState<OverviewItem | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessTotal, setSessTotal] = useState(0);
  const [sessPage, setSessPage] = useState(1);
  const SESS_PAGE_SIZE = 10;
  const [rangeKey, setRangeKey] = useState('15m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [diag, setDiag] = useState<Summary | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tick, setTick] = useState(0); // 自动刷新计数：每 5s + 返回页面时自增，驱动趋势/会话/概览重取
  const [kind, setKind] = useState('pull');
  const [intervalMs, setIntervalMs] = useState(1000);
  const [enabled, setEnabled] = useState(true);
  const [scrapeSec, setScrapeSec] = useState(5);
  const [saving, setSaving] = useState(false);
  const [exportHint, setExportHint] = useState<string | null>(null);
  const [pushTest, setPushTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [pushTesting, setPushTesting] = useState(false);
  // collector 要推到的本服务地址：默认当前页 origin，但 collector 在别的机器上时 localhost 不通 → 可改成本机可达的 IP/域名。
  const [ingestUrl, setIngestUrl] = useState('');
  const loadMeta = useCallback(async () => {
    if (!id) return;
    const ov = await (await fetch('/api/observe/infra/sources/overview')).json();
    const found: OverviewItem | undefined = (ov.overview ?? []).find((o: OverviewItem) => o.source.id === id);
    if (!found) { setNotFound(true); return; }
    setItem(found);
    setKind(found.source.kind);
    setIntervalMs(found.source.scrapeIntervalMs);
    setEnabled(found.source.enabled);
    setModels(found.models ?? []);
    setSelectedModel((cur) => cur || found.primaryModel || found.models?.[0] || '');
    // ingest 地址来自部署固定的 AGENT_INSIGHT_HOST（服务端给），不是每源手填
    setIngestUrl((cur) => cur || ov.ingestEndpoint || `${window.location.origin}/api/ingest/otel/v1/metrics`);
  }, [id]);
  // 元数据
  useEffect(() => {
    let active = true;
    (async () => { await Promise.resolve(); if (active) await loadMeta(); })();
    return () => { active = false; };
  }, [loadMeta, tick]);
  // 历史趋势：随选中 model / 时间段变化重取
  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      await Promise.resolve();
      let qs = `sourceId=${encodeURIComponent(id)}`;
      if (selectedModel) qs += `&model=${encodeURIComponent(selectedModel)}`;
      if (rangeKey === 'custom') {
        if (customFrom) qs += `&from=${new Date(customFrom).getTime()}`;
        if (customTo) qs += `&to=${new Date(customTo).getTime()}`;
      } else {
        const r = RANGES.find((x) => x.key === rangeKey);
        qs += `&from=${Date.now() - (r?.ms ?? 900_000)}`;
      }
      const hi = await (await fetch(`/api/observe/infra/history?${qs}`)).json();
      if (active) setPoints(hi.points ?? []);
    })();
    return () => { active = false; };
  }, [id, selectedModel, rangeKey, customFrom, customTo, tick]);
  // 当前选中的时间段 → [from, to]。自定义但没填起始时间 → null（调用方各自处理）。
  // 会话列表与导出共用，保证「导出的就是屏幕上这段」。
  const resolveRange = useCallback((): { from: number; to: number } | null => {
    if (rangeKey === 'custom') {
      if (!customFrom) return null;
      return { from: new Date(customFrom).getTime(), to: customTo ? new Date(customTo).getTime() : Date.now() };
    }
    const to = Date.now();
    return { from: to - (RANGES.find((x) => x.key === rangeKey)?.ms ?? 900_000), to };
  }, [rangeKey, customFrom, customTo]);

  // 相关会话：与历史趋势同一时间段，列出命中该源 endpoint 的 execution（哪些 session 在这段时间干活），分页
  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      await Promise.resolve();
      const r = resolveRange();
      if (!r) { if (active) { setSessions([]); setSessTotal(0); } return; }
      const { from, to } = r;
      const body = await (await fetch(`/api/observe/infra/sources/sessions?sourceId=${encodeURIComponent(id)}&from=${from}&to=${to}&page=${sessPage}&pageSize=${SESS_PAGE_SIZE}`)).json();
      if (active) { setSessions(body.sessions ?? []); setSessTotal(body.total ?? 0); }
    })();
    return () => { active = false; };
  }, [id, resolveRange, sessPage, tick]);

  // 导出当前时间段的原始时序为 CSV。走 <a download> 而不是 fetch+Blob：
  // 6h 约 1 万行、24h 约 4.3 万行，让浏览器直接落盘，不必先塞进内存。
  const exportCsv = useCallback(() => {
    if (!id) return;
    const r = resolveRange();
    if (!r) { setExportHint('请先填写自定义时间段的起始时间'); return; }
    const qs = new URLSearchParams({ sourceId: id, from: String(r.from), to: String(r.to) });
    if (selectedModel) qs.set('model', selectedModel);
    const a = document.createElement('a');
    a.href = `/api/observe/infra/export?${qs}`;
    a.download = ''; // 文件名以服务端 Content-Disposition 为准
    document.body.appendChild(a);
    a.click();
    a.remove();
    setExportHint(null);
    reportClientUsage('infra', 'infra.export');
  }, [id, resolveRange, selectedModel]);

  // 自动刷新：每 5s（仅标签可见时）+ 返回页面（bfcache 恢复/切回标签）即刷，自增 tick 驱动上面三个 effect 重取。
  // 大范围（6h/24h/自定义）关掉 5s 周期刷新——那会每 5s 重拉上千行 + 重渲九张图，太重；
  // 仍保留「切回页面/恢复」时的一次性刷新。小范围（5m/15m/1h）维持 5s 实时。
  useEffect(() => {
    const PERIODIC = new Set(['5m', '15m', '1h']);
    const bump = () => setTick((t) => t + 1);
    const id = setInterval(() => { if (document.visibilityState === 'visible' && PERIODIC.has(rangeKey)) bump(); }, 5000);
    const onShow = () => bump();
    const onVis = () => { if (document.visibilityState === 'visible') bump(); };
    window.addEventListener('pageshow', onShow);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      window.removeEventListener('pageshow', onShow);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [rangeKey]);

  const runDiagnose = useCallback(async () => {
    if (!item) return;
    setDiagLoading(true);
    setDiagError(null);
    try {
      const url = `/api/observe/infra/diagnose?target=${encodeURIComponent(item.source.endpoint)}&samples=2${selectedModel ? `&model=${encodeURIComponent(selectedModel)}` : ''}`;
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok || !body?.slis) throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
      setDiag(body as Summary);
    } catch (e) {
      setDiag(null);
      setDiagError(e instanceof Error ? e.message : String(e));
    } finally { setDiagLoading(false); }
  }, [item, selectedModel]);

  const save = useCallback(async () => {
    if (!item) return;
    setSaving(true);
    try {
      await fetch('/api/observe/infra/sources', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.source.id, kind, scrapeIntervalMs: intervalMs, enabled }) });
      await loadMeta();
    } finally { setSaving(false); }
  }, [item, kind, intervalMs, enabled, loadMeta]);

  const detectPush = useCallback(async (silent = false) => {
    if (!item) return;
    if (!silent) setPushTesting(true);
    try {
      const body = await (await fetch(`/api/observe/infra/sources/test?mode=push&sourceId=${encodeURIComponent(item.source.id)}`)).json();
      setPushTest({ ok: !!body.ok, message: body.message || body.error || '检测失败' });
    } catch (e) {
      setPushTest({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally { if (!silent) setPushTesting(false); }
  }, [item]);

  // 只要在配置/使用推送（下拉选了 push），本页就每 3s 自动检测推送；collector 一推起来就转「✓ 已收到」。
  // 这样支持"先配 collector → 检测到 → 再保存切换"的流程（检测查的是 push 样本，与是否已保存无关）。
  useEffect(() => {
    if (kind !== 'push' || !item) return;
    let active = true;
    const tick = () => { if (active) void detectPush(true); };
    const t0 = setTimeout(tick, 0);
    const t = setInterval(tick, 3000);
    return () => { active = false; clearTimeout(t0); clearInterval(t); };
  }, [kind, item, detectPush]);

  if (notFound) return (<><AppTopBar title="推理 Infra 源" /><div style={{ padding: 24 }}><a href="/infra" style={{ color: 'var(--primary)' }}>← 返回</a><p>未找到该源。</p></div></>);
  if (!item) return (<><AppTopBar title="推理 Infra 源" /><div style={{ padding: 24, color: 'var(--foreground-muted)' }}>加载中…</div></>);

  // KV 纵轴上界：在 JS 里按数据算定值（不要用 Recharts 的函数型 domain——v3 不认 per-element 函数，
  // 会把 y 轴 scale 算坏，导致线渲染到退化位置「看不见」但 tooltip 仍有值）。
  // 带 1.3x 留白、封顶 100、最低 2，让轻负载(KV≈几个百分点)的曲线也落在可见高度，而不是贴着 X 轴。
  const kvMax = (() => {
    const m = points.reduce((a, p) => (typeof p.kvPerc === 'number' && p.kvPerc > a ? p.kvPerc : a), 0);
    const head = Math.max(m * 1.3, 1);
    const nice = head <= 5 ? Math.ceil(head) : Math.ceil(head / 5) * 5;
    return Math.min(100, Math.max(2, nice));
  })();

  const tone = item.verdict ? VERDICT_TONE[item.verdict] ?? VERDICT_TONE.idle : VERDICT_TONE.idle;
  const dTone = diag ? VERDICT_TONE[diag.verdict] ?? VERDICT_TONE.idle : null;
  // 从「非 push」切到 push 时：要求先检测到推送才能保存（先配 collector → 检测到 → 再保存切换）。
  const needPushFirst = kind === 'push' && item.source.kind !== 'push' && !pushTest?.ok;

  return (
    <>
      <AppTopBar title="推理 Infra 源" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24, color: 'var(--foreground)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <a href="/infra" style={{ color: 'var(--primary)', fontSize: 13 }}>← 所有源</a>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>时间段</span>
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => { setRangeKey(r.key); setSessPage(1); }}
                style={{ padding: '5px 10px', fontSize: 12, border: 'none', borderRight: '1px solid var(--border)', cursor: 'pointer', background: rangeKey === r.key ? 'var(--primary)' : 'var(--background)', color: rangeKey === r.key ? 'var(--primary-foreground)' : 'var(--foreground-secondary)' }}
              >
                {r.label}
              </button>
            ))}
            <button
              onClick={() => { setRangeKey('custom'); setSessPage(1); }}
              style={{ padding: '5px 10px', fontSize: 12, border: 'none', cursor: 'pointer', background: rangeKey === 'custom' ? 'var(--primary)' : 'var(--background)', color: rangeKey === 'custom' ? 'var(--primary-foreground)' : 'var(--foreground-secondary)' }}
            >
              自定义
            </button>
          </div>
          {rangeKey === 'custom' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="datetime-local" value={customFrom} onChange={(e) => { setCustomFrom(e.target.value); setSessPage(1); }} style={field} />
              <span style={{ color: 'var(--foreground-muted)' }}>—</span>
              <input type="datetime-local" value={customTo} onChange={(e) => { setCustomTo(e.target.value); setSessPage(1); }} style={field} />
            </span>
          )}
          <button onClick={exportCsv} style={{ ...field, cursor: 'pointer' }} title="导出当前时间段的逐点原始时序为 CSV（不降采样，含 p50/p95/p99 与裸累计计数器），可直接丢给大模型或 Excel 分析">
            导出 CSV
          </button>
          {exportHint && <span style={{ fontSize: 12, color: 'var(--warning)' }}>{exportHint}</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{item.source.endpoint}</h2>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 999, padding: '2px 10px' }}>
            {tone.label}{item.bottleneck && item.bottleneck !== 'none' ? ` · ${item.bottleneck}` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--foreground-muted)' }}>
            {item.source.kind === 'pull' ? `主动拉取 · ${(item.source.scrapeIntervalMs / 1000).toFixed(0)}s` : 'Collector 推送'}{item.source.hardwareName ? ` · ${item.source.hardwareName}` : ''}{!item.source.enabled ? ' · 已停用' : ''}
          </span>
          {/* 模型选择：一个 endpoint 多模型时切换 */}
          {models.length > 0 && (
            <span style={{ fontSize: 13, color: 'var(--foreground-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              模型
              {models.length > 1 ? (
                <select value={selectedModel} onChange={(e) => { setSelectedModel(e.target.value); setDiag(null); }} style={field}>
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : <b style={{ color: 'var(--foreground)' }}>{models[0]}</b>}
              {models.length > 1 && <span style={{ color: 'var(--foreground-muted)' }}>（共 {models.length} 个）</span>}
            </span>
          )}
        </div>

        <h3 style={{ margin: '0 0 10px' }}>历史趋势{models.length > 1 ? `（${selectedModel}）` : ''}</h3>
        {points.length < 2 ? (
          <div style={{ color: 'var(--foreground-muted)', fontSize: 13, marginBottom: 24 }}>采样不足（至少 2 条）。自动拉取攒一会，或到源管理点「立即拉取一轮」。</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, marginBottom: 28 }}>
            <MiniChart title="调度：并发 / 排队" explain="并发=正在推理的请求数；排队=在等待、还没开始算的请求数。排队持续 >0 = 容量不够/过载。并发高且排队≈0 最理想；排队越低越好。" data={points} series={[{ key: 'running', name: '并发', color: 'var(--primary)' }, { key: 'waiting', name: '排队', color: 'var(--warning)' }]} />
            <MiniChart title="排队原因：容量 / 延后" explain="把「排队」拆成原因。capacity=因显存/KV 容量不足而排队（要扩容或降负载）；deferred=被调度策略主动延后。capacity >0 是容量瓶颈信号；两者都越低越好。" data={points} series={[{ key: 'waitingCapacity', name: 'capacity', color: 'var(--error)' }, { key: 'waitingDeferred', name: 'deferred', color: 'var(--warning)' }]} />
            <MiniChart title={`KV 使用率 %（轴顶 ${kvMax}%）`} explain="KV cache 占用的显存比例。>90% 接近占满，会触发抢占/排队；<80% 健康。纵轴按当前数据自适应放大、封顶 100%——所以负载轻时也能看见曲线，但要看标题里的「轴顶 N%」判断真实高低：轴顶是个位数=负载很轻，逼近 100 才危险。" data={points} series={[{ key: 'kvPerc', name: 'KV%', color: 'var(--error)' }]} yDomain={[0, kvMax]} />
            <MiniChart title="吞吐 tok/s：输入 / 生成" explain="每秒处理的 token 数：输入=prompt 侧，生成=输出侧。越高=吞吐越大（好），但要结合延迟一起看。空载时为 0 属正常。" data={points} series={[{ key: 'promptTokPerS', name: 'prompt', color: 'var(--primary)' }, { key: 'genTokPerS', name: 'gen', color: 'var(--success)' }]} />
            <MiniChart title="首 token 延迟分段 p95 (s)：TTFT / 排队 / prefill" explain="TTFT=用户发出到看到第一个字的时间（=排队+prefill），越低越好（交互场景 p95<0.5s）。看 TTFT 高时是 queue(排队)主导还是 prefill(首次计算)主导，就能定位是「堵」还是「算得慢」。都越低越好。" data={points} series={[{ key: 'ttftP95', name: 'TTFT', color: 'var(--primary)' }, { key: 'queueP95', name: 'queue', color: 'var(--warning)' }, { key: 'prefillP95', name: 'prefill', color: 'var(--success)' }]} />
            <MiniChart title="decode 延迟 p95 (ms)：ITL / TPOT" explain="decode（逐 token 生成）阶段的「吐字快不快」，两个口径都是越低越好：<50ms 几乎无感、50–100ms 可接受、>100ms 开始卡顿。 ITL（Inter-Token Latency，token 间延迟）=相邻两个输出 token 的瞬时间隔，能看出抖动/毛刺（如被抢占）。 TPOT（Time Per Output Token，每输出 token 耗时）=（总生成耗时−TTFT）÷（输出 token 数−1），是摊薄后的平均值，把抖动抹平。数值上 TPOT≈ITL 的平均。 注意它俩衡量的是「出字速度」，而 TTFT 衡量的是「等多久开始出字」，是两回事。偏高通常是 decode 受显存带宽限制（增大 batch / 量化可缓解）。" data={points} series={[{ key: 'itlP95Ms', name: 'ITL', color: 'var(--warning)' }, { key: 'tpotP95Ms', name: 'TPOT', color: 'var(--error)' }]} />
            <MiniChart title="端到端延迟 p95 (s)" explain="单个请求从进到出的总耗时（秒）≈ 排队 + prefill + 全部 decode。越低越好；它是用户实际感受到的总等待。" data={points} series={[{ key: 'e2eP95', name: 'e2e', color: 'var(--primary)' }]} />
            <MiniChart title="Prefix 命中 %" explain="提示词前缀缓存命中率。越高越好（>80% 优秀）：命中越多，越能跳过重复的 prefill 计算、降低 TTFT、省算力。低（<50%）说明提示词复用差、每次都在重算。" data={points} series={[{ key: 'prefixHitPerc', name: 'Prefix', color: 'var(--success)' }]} yDomain={[0, 100]} />
            <MiniChart title="抢占 次/s" explain="单位时间内被驱逐重算的序列数。应≈0：>0 说明 KV 过载、运行中的请求被踢掉重算，会让尾延迟剧烈抖动。越低越好，理想是 0。" data={points} series={[{ key: 'preemptRate', name: 'preempt', color: 'var(--error)' }]} />
          </div>
        )}

        {/* 相关会话：同一时间段内命中该源的 session（点回 trace 详情的 Infra tab），分页 */}
        <h3 style={{ margin: '0 0 10px' }}>相关会话（该时间段内命中此源的调用 · 共 {sessTotal}）</h3>
        {sessTotal === 0 ? (
          <div style={{ color: 'var(--foreground-muted)', fontSize: 13, marginBottom: 28 }}>该时间段内没有命中此源的会话调用。上方切换时间段可改变范围。</div>
        ) : (
          <div style={{ marginBottom: 28 }}>
            <div style={{ border: '1px solid var(--card-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 90px 90px 90px', gap: 8, padding: '8px 12px', background: 'var(--background-secondary)', fontSize: 11.5, color: 'var(--foreground-muted)', fontWeight: 600 }}>
                <span>时间</span><span>会话 / Agent</span><span style={{ textAlign: 'right' }}>延迟</span><span style={{ textAlign: 'right' }}>输出tok</span><span style={{ textAlign: 'right' }}>模型</span>
              </div>
              {sessions.map((s) => (
                <a key={s.id} href={`/trace?taskId=${encodeURIComponent(s.taskId || s.id)}`}
                  style={{ display: 'grid', gridTemplateColumns: '120px 1fr 90px 90px 90px', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 12.5, color: 'inherit', textDecoration: 'none', alignItems: 'center' }}>
                  <span style={{ color: 'var(--foreground-muted)', fontVariantNumeric: 'tabular-nums' }}>{hhmmss(s.tsMs)}</span>
                  <span style={{ color: 'var(--primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.agentName || s.taskId || s.id} →</span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.latencyMs == null ? 'n/a' : `${(s.latencyMs / 1000).toFixed(1)}s`}</span>
                  <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.outputTokens ?? 'n/a'}</span>
                  <span style={{ textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground-muted)' }}>{s.model ?? '—'}</span>
                </a>
              ))}
            </div>
            {sessTotal > SESS_PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 12.5 }}>
                <button onClick={() => setSessPage((p) => Math.max(1, p - 1))} disabled={sessPage <= 1}
                  style={{ ...field, cursor: sessPage <= 1 ? 'default' : 'pointer', opacity: sessPage <= 1 ? 0.5 : 1 }}>上一页</button>
                <span style={{ color: 'var(--foreground-muted)' }}>第 {sessPage} / {Math.ceil(sessTotal / SESS_PAGE_SIZE)} 页</span>
                <button onClick={() => setSessPage((p) => Math.min(Math.ceil(sessTotal / SESS_PAGE_SIZE), p + 1))} disabled={sessPage >= Math.ceil(sessTotal / SESS_PAGE_SIZE)}
                  style={{ ...field, cursor: sessPage >= Math.ceil(sessTotal / SESS_PAGE_SIZE) ? 'default' : 'pointer', opacity: sessPage >= Math.ceil(sessTotal / SESS_PAGE_SIZE) ? 0.5 : 1 }}>下一页</button>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 10px' }}>
          <h3 style={{ margin: 0 }}>实时诊断{models.length > 1 ? `（${selectedModel}）` : ''}</h3>
          <button onClick={runDiagnose} disabled={diagLoading} style={{ ...field, cursor: 'pointer', background: 'var(--primary)', color: 'var(--primary-foreground)', border: 'none', padding: '6px 14px' }}>
            {diagLoading ? '诊断中…' : '立即诊断（采 2 次）'}
          </button>
        </div>
        {diagError && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 20 }}>诊断失败：{diagError}</div>}
        {diag && diag.slis && dTone && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', marginBottom: 12, borderRadius: 'var(--radius-lg)', background: dTone.bg, border: `1px solid ${dTone.border}` }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: dTone.fg }}>{dTone.label}</span>
              <span style={{ color: 'var(--foreground-secondary)', fontSize: 13 }}>主瓶颈：<b>{diag.bottleneck}</b> · 采样 {diag.samples} · model {diag.model ?? 'n/a'}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginBottom: 14 }}>
              <Card label="并发(peak)" value={String(diag.slis.runningPeak)} />
              <Card label="排队(peak)" value={String(diag.slis.waitingPeak)} />
              <Card label="KV 峰值" value={fmt(diag.slis.kvPeakPerc, 1, '%')} />
              <Card label="生成 tok/s" value={fmt(diag.slis.genTokPerS, 1)} />
              <Card label="TTFT p95" value={fmt(diag.slis.ttftP95, 2, 's')} />
              <Card label="ITL p95" value={diag.slis.itlP95 == null ? 'n/a' : fmt(diag.slis.itlP95 * 1000, 0, 'ms')} />
              <Card label="Prefix 命中" value={diag.slis.prefixHit == null ? 'n/a' : fmt(diag.slis.prefixHit * 100, 1, '%')} />
              <Card label="抢占/s" value={fmt(diag.slis.preemptRate, 2)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {diag.findings.map((f, i) => (
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

        <h3 style={{ margin: '0 0 10px' }}>采集配置</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <label><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用</label>
          采集方式
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={field}>
            <option value="pull">主动拉取 (PULL)</option>
            <option value="push">Collector 推送 (PUSH)</option>
          </select>
          {kind === 'pull' && (<>间隔<input type="number" min={1000} step={1000} value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} style={{ ...field, width: 92 }} />ms（{(intervalMs / 1000).toFixed(0)}s）</>)}
          <button
            onClick={save}
            disabled={saving || needPushFirst}
            title={needPushFirst ? '切换到推送前，请先按下方配置启动 collector，待检测到推送后再保存' : ''}
            style={{ ...field, cursor: needPushFirst ? 'not-allowed' : 'pointer', background: needPushFirst ? 'var(--background-secondary)' : 'var(--primary)', color: needPushFirst ? 'var(--foreground-muted)' : 'var(--primary-foreground)', border: 'none', padding: '6px 14px' }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          {needPushFirst && <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>← 先按下方配置启动 collector，检测到推送后才能保存切换</span>}
        </div>

        {kind === 'pull' && <div style={{ fontSize: 13, color: 'var(--foreground-muted)', marginBottom: 24 }}>主动拉取：agent-insight 每 {(intervalMs / 1000).toFixed(0)}s 去 GET <code>{item.source.scrapeUrl}</code>，对方无需安装任何东西。</div>}

        {kind === 'push' && (
          <div style={{ marginBottom: 24 }}>
            {/* 接入状态：本页每 3s 自动检测推送（查 push 样本，与是否已保存无关） */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 14, borderRadius: 'var(--radius-md)',
              background: pushTest?.ok ? 'var(--success-subtle)' : 'var(--background-secondary)',
              border: `1px solid ${pushTest?.ok ? 'var(--success-subtle-border)' : 'var(--border)'}`,
            }}>
              <span style={{ fontSize: 16 }}>{pushTest?.ok ? '✓' : '⏳'}</span>
              <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>
                {pushTest?.ok ? '已收到 collector 推送' : '等待 collector 推送…'}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--foreground-muted)' }}>{pushTest?.message ?? '本页每 3s 自动检测，启动 collector 后自动转为已收到'}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => detectPush(false)} disabled={pushTesting} style={{ ...field, cursor: 'pointer' }}>{pushTesting ? '检测中…' : '立即检测'}</button>
            </div>

            <div style={{ fontSize: 13, color: 'var(--foreground)', marginBottom: 10, lineHeight: 1.8 }}>
              <b>推送模式 = 你自己在能访问该源的机器上跑一个 OTel Collector 把指标推过来</b>（本服务不会替你启动 collector）。建议流程：
              <div style={{ marginTop: 6, color: 'var(--foreground-secondary)' }}>① 设好上报周期 + 本服务可达地址 → 复制下面的 <code>otelcol.yaml</code></div>
              <div style={{ color: 'var(--foreground-secondary)' }}>② 在能访问 <code>{item.source.endpoint}</code> 的机器上启动：<code>otelcol-contrib --config otelcol.yaml</code></div>
              <div style={{ color: 'var(--foreground-secondary)' }}>③ 上方状态变「✓ 已收到推送」后，再点上面「保存」把采集方式正式切到推送（切换前可一直保持主动拉）</div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--foreground-muted)', marginBottom: 8, flexWrap: 'wrap' }}>
              <span>上报周期</span>
              <input type="number" min={1} step={1} value={scrapeSec} onChange={(e) => setScrapeSec(Math.max(1, Number(e.target.value)))} style={{ ...field, width: 60 }} /><span>s（须 ≥ 目标响应时间，否则 scrape 超时；本地可 1~2s，经 Tailscale 的 GX10 建议 5s）</span>
              <span style={{ marginLeft: 12 }}>本服务可达地址</span>
              <input value={ingestUrl} onChange={(e) => setIngestUrl(e.target.value)} style={{ ...field, width: 360 }} title="collector 在别的机器上时，把 localhost 改成本机可达的 IP/域名" />
            </div>
            <pre style={{ background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre', color: 'var(--foreground)' }}>
              {collectorYaml(item.source.endpoint, ingestUrl, scrapeSec)}
            </pre>
            <div style={{ fontSize: 12, color: 'var(--foreground-muted)', marginTop: 6, lineHeight: 1.7 }}>
              · <code>targets</code> 已自动填为该源地址 <code>{(() => { try { return new URL(item.source.endpoint).host; } catch { return item.source.endpoint; } })()}</code>（collector 要抓的就是它，不是写死）。<br />
              · <code>metrics_endpoint</code> 取自部署配置 <code>AGENT_INSIGHT_HOST</code>（部署后固定）；若它是 <code>localhost</code> 而 collector 在<b>别的机器</b>上，把上面「本服务可达地址」改成本服务可达的 IP/域名。<br />
              · 接收端点同时支持 OTLP/protobuf（collector 默认）与 OTLP/json，无需配 encoding。
            </div>
          </div>
        )}
      </div>
    </>
  );
}
