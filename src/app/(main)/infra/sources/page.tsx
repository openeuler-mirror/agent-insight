'use client';

import { useCallback, useEffect, useState } from 'react';

import { AppTopBar } from '@/components/shell/AppTopBar';

interface InfraSource {
  id: string;
  endpoint: string;
  scrapeUrl: string;
  kind: string;
  model: string | null;
  hardwareName: string | null;
  memBandwidthGBs: number | null;
  scrapeIntervalMs: number;
  enabled: boolean;
}
interface Candidate {
  endpoint: string;
  models: string[];
  count: number;
  registered: boolean;
  probe: { reachable: boolean; metricCount: number; model: string | null; error?: string };
}

const card = {
  padding: '12px 16px',
  borderRadius: 'var(--radius-md)',
  background: 'var(--card-bg)',
  border: '1px solid var(--card-border)',
} as const;

function btn(bg: string, fg: string) {
  return {
    padding: '7px 14px', borderRadius: 'var(--radius-md)',
    border: bg === 'transparent' ? '1px solid var(--border)' : 'none',
    cursor: 'pointer', background: bg, color: fg, fontSize: 13,
  } as const;
}
const field = {
  padding: '5px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--background)', color: 'var(--foreground)', fontSize: 13,
} as const;

// 单个已注册源：可改采集方式(pull/push) + 采集间隔(pull 时) + 启用，保存走 PATCH。
function SourceRow({ s, onChanged }: { s: InfraSource; onChanged: () => void }) {
  const [kind, setKind] = useState(s.kind);
  const [intervalMs, setIntervalMs] = useState(s.scrapeIntervalMs);
  const [enabled, setEnabled] = useState(s.enabled);
  const [saving, setSaving] = useState(false);

  const dirty = kind !== s.kind || intervalMs !== s.scrapeIntervalMs || enabled !== s.enabled;

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await fetch('/api/observe/infra/sources', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, kind, scrapeIntervalMs: intervalMs, enabled }),
      });
      onChanged();
    } finally {
      setSaving(false);
    }
  }, [s.id, kind, intervalMs, enabled, onChanged]);

  const remove = useCallback(async () => {
    await fetch(`/api/observe/infra/sources?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    onChanged();
  }, [s.id, onChanged]);

  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} title="启用" />
      <span style={{ fontWeight: 600 }}>{s.endpoint}</span>
      <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>{s.model ?? 'model n/a'}{s.hardwareName ? ` · ${s.hardwareName}` : ''}</span>
      <span style={{ flex: 1 }} />

      <label style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>采集方式</label>
      <select value={kind} onChange={(e) => setKind(e.target.value)} style={field}>
        <option value="pull">主动拉取 (PULL)</option>
        <option value="push">Collector 推送 (PUSH)</option>
      </select>

      {kind === 'pull' && (
        <>
          <label style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>采集间隔</label>
          <input
            type="number" min={1000} step={1000} value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            style={{ ...field, width: 92 }} title="毫秒，>=1000"
          />
          <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>ms（{(intervalMs / 1000).toFixed(0)}s）</span>
        </>
      )}

      <button onClick={save} disabled={!dirty || saving} style={btn(dirty ? 'var(--primary)' : 'var(--background-secondary)', dirty ? 'var(--primary-foreground)' : 'var(--foreground-muted)')}>
        {saving ? '保存中…' : '保存'}
      </button>
      <a href={`/infra?target=${encodeURIComponent(s.endpoint)}`} style={{ color: 'var(--primary)', fontSize: 13 }}>诊断</a>
      <button onClick={remove} style={btn('transparent', 'var(--error)')}>删除</button>
    </div>
  );
}

export default function InfraSourcesPage() {
  const [sources, setSources] = useState<InfraSource[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 手动新增表单
  const [newUrl, setNewUrl] = useState('');
  const [newKind, setNewKind] = useState('pull');
  const [newInterval, setNewInterval] = useState(1000);
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState<{ ok: boolean; message: string } | null>(null);

  const testPull = useCallback(async () => {
    if (!newUrl) return;
    setTesting(true);
    setTestRes(null);
    try {
      const res = await fetch(`/api/observe/infra/sources/test?mode=pull&endpoint=${encodeURIComponent(newUrl)}`);
      const body = await res.json();
      setTestRes({ ok: !!body.ok, message: body.message || body.error || '检测失败' });
    } catch (e) {
      setTestRes({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }, [newUrl]);

  const loadSources = useCallback(async () => {
    const res = await fetch('/api/observe/infra/sources');
    const body = await res.json();
    setSources(body.sources ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/observe/infra/sources');
      const body = await res.json();
      setSources(body.sources ?? []);
    })();
  }, []);

  const derive = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch('/api/observe/infra/sources/derive');
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
      setCandidates(body.candidates ?? []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const addManual = useCallback(async () => {
    if (!newUrl) return;
    setBusy('add');
    try {
      const res = await fetch('/api/observe/infra/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: newUrl, kind: newKind, scrapeIntervalMs: newInterval }),
      });
      const body = await res.json();
      if (!res.ok) { setMsg(body.message || body.error || '添加失败'); return; }
      setNewUrl('');
      await loadSources();
    } finally {
      setBusy(null);
    }
  }, [newUrl, newKind, newInterval, loadSources]);

  const importSource = useCallback(async (c: Candidate) => {
    setBusy(c.endpoint);
    try {
      await fetch('/api/observe/infra/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: c.endpoint, model: c.probe.model ?? c.models[0], kind: 'pull' }),
      });
      await loadSources();
      await derive();
    } finally {
      setBusy(null);
    }
  }, [loadSources, derive]);

  const poll = useCallback(async () => {
    setBusy('poll');
    try {
      const res = await fetch('/api/observe/infra/poll', { method: 'POST' });
      const body = await res.json();
      setMsg(`拉取完成：成功 ${body.polled}，失败 ${body.failed}`);
      await loadSources();
    } finally {
      setBusy(null);
    }
  }, [loadSources]);

  return (
    <>
      <AppTopBar title="推理 Infra 源" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24, color: 'var(--foreground)' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <a href="/infra" style={{ color: 'var(--primary)' }}>← 观测面板</a>
          <span style={{ flex: 1 }} />
          <button onClick={derive} disabled={loading} style={btn('var(--background-secondary)', 'var(--foreground)')}>
            {loading ? '探测中…' : '自动发现候选源'}
          </button>
          <button onClick={poll} disabled={busy === 'poll'} style={btn('var(--primary)', 'var(--primary-foreground)')}>
            {busy === 'poll' ? '拉取中…' : '立即拉取一轮'}
          </button>
        </div>

        {/* 手动新增 */}
        <div style={{ ...card, marginBottom: 18 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={newUrl} onChange={(e) => { setNewUrl(e.target.value); setTestRes(null); }} placeholder="新增源 URL，如 http://host:8000" style={{ ...field, flex: 1, minWidth: 240 }} />
            <select value={newKind} onChange={(e) => { setNewKind(e.target.value); setTestRes(null); }} style={field}>
              <option value="pull">主动拉取 (PULL)</option>
              <option value="push">Collector 推送 (PUSH)</option>
            </select>
            {newKind === 'pull' && (
              <input type="number" min={1000} step={1000} value={newInterval} onChange={(e) => setNewInterval(Number(e.target.value))} style={{ ...field, width: 92 }} title="采集间隔 ms" />
            )}
            {newKind === 'pull' && (
              <button onClick={testPull} disabled={!newUrl || testing} style={btn('var(--background-secondary)', 'var(--foreground)')}>
                {testing ? '检测中…' : '测试连接'}
              </button>
            )}
            <button
              onClick={addManual}
              disabled={!newUrl || busy === 'add' || (newKind === 'pull' && !testRes?.ok)}
              title={newKind === 'pull' && !testRes?.ok ? '请先测试连接通过再添加' : ''}
              style={btn(newKind === 'push' || testRes?.ok ? 'var(--primary)' : 'var(--background-secondary)', newKind === 'push' || testRes?.ok ? 'var(--primary-foreground)' : 'var(--foreground-muted)')}
            >
              {busy === 'add' ? '添加中…' : '添加源'}
            </button>
          </div>
          {newKind === 'pull' && testRes && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: testRes.ok ? 'var(--success)' : 'var(--error)' }}>
              {testRes.ok ? '✓ ' : '✗ '}{testRes.message}
            </div>
          )}
          {newKind === 'pull' && !testRes && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--foreground-muted)' }}>主动拉取：先「测试连接」探测 /metrics，通过后才能添加。</div>
          )}
          {newKind === 'push' && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--foreground-muted)' }}>推送模式：添加后到该源详情页拿生成的 collector 配置，启动 collector 后用「检测推送」确认收到数据。</div>
          )}
        </div>

        {msg && <div style={{ marginBottom: 16, color: 'var(--foreground-secondary)' }}>{msg}</div>}

        <h3 style={{ margin: '0 0 10px' }}>已注册源（{sources.length}）</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
          {sources.length === 0 && <div style={{ color: 'var(--foreground-muted)' }}>暂无。上面手动添加，或下方自动发现后一键导入。</div>}
          {sources.map((s) => <SourceRow key={s.id} s={s} onChanged={loadSources} />)}
        </div>

        {candidates.length > 0 && (
          <>
            <h3 style={{ margin: '0 0 10px' }}>从历史会话发现的候选源（{candidates.length}）</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {candidates.map((c) => (
                <div key={c.endpoint} style={{ ...card, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ color: c.probe.reachable ? 'var(--success)' : 'var(--foreground-muted)' }}>{c.probe.reachable ? '✓' : '○'}</span>
                  <span style={{ fontWeight: 600 }}>{c.endpoint}</span>
                  <span style={{ fontSize: 12, color: 'var(--foreground-muted)' }}>
                    {c.count} 次调用 · {c.probe.reachable ? `${c.probe.metricCount} 指标 · ${c.probe.model ?? c.models.join(',')}` : `外部/不可达${c.probe.error ? ` (${c.probe.error})` : ''}`}
                  </span>
                  <span style={{ flex: 1 }} />
                  {c.registered ? <span style={{ fontSize: 13, color: 'var(--foreground-muted)' }}>已注册</span>
                    : c.probe.reachable ? (
                      <button onClick={() => importSource(c)} disabled={busy === c.endpoint} style={btn('var(--primary)', 'var(--primary-foreground)')}>
                        {busy === c.endpoint ? '导入中…' : '一键导入'}
                      </button>
                    ) : <span style={{ fontSize: 13, color: 'var(--foreground-muted)' }}>不可观测</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
