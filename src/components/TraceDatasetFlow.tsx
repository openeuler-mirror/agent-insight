/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use client';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { apiFetch } from '@/lib/client/api';
import { EXCLUSION_REASONS, STAGE_LABELS, type GenerationConfig, type GenerationProgress } from '@/lib/trace-datasets/contracts';
import { useAuth } from '@/lib/auth/auth-context';
import { Check } from 'lucide-react';
import styles from './TraceDatasetFlow.module.css';

const inputStyle: CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', color: 'var(--foreground)', background: 'var(--background)' };
const errorText = (data: { error?: string | { message?: string } }, fallback: string) => typeof data.error === 'string' ? data.error : data.error?.message || fallback;
const generationStages = ['read', 'dedup', 'stratify', 'sample', 'convert', 'save'];
function RequiredMark() { return <span aria-hidden="true" className={styles.required}>*</span>; }
function uuidv7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let i = 5; i >= 0; i--) { bytes[i] = time % 256; time = Math.floor(time / 256); }
  bytes[6] = 0x70 | (bytes[6] & 15); bytes[8] = 0x80 | (bytes[8] & 63);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function cleanTraceDataset(id: string, user: string, cancel = false) {
  const response = await apiFetch(cancel ? `/api/agent-datasets/${id}/generation/cancel` : `/api/agent-datasets/${id}?user=${encodeURIComponent(user)}`, { method: cancel ? 'POST' : 'DELETE' });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw new Error(errorText(data, '清理失败'));
  for (;;) {
    const status = await apiFetch(`/api/agent-datasets/deletions/${data.deletionId}`);
    const body = await status.json();
    if (!status.ok) throw new Error(errorText(body, '读取清理状态失败，请重试'));
    if (body.status === 'deleted') return;
    if (body.status === 'cleanup_failed') throw new Error(errorText(body, '清理失败，请重试'));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
export default function TraceDatasetFlow({ initialId, initialName, initialConfig, replaceId, onClose, onChange }: { initialId?: string; initialName?: string; initialConfig?: GenerationConfig; replaceId?: string; onClose: () => void; onChange: () => void }) {
  const { apiKey, user } = useAuth();
  const [id, setId] = useState(initialId);
  const currentId = useRef(id);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [name, setName] = useState(initialConfig?.name || initialName || '');
  const [description, setDescription] = useState(initialConfig?.description || '');
  const [platform, setPlatform] = useState(initialConfig?.platform || '');
  const [agentKey, setAgentKey] = useState(initialConfig?.agentKey || '');
  const [days, setDays] = useState(initialConfig ? String((Date.parse(initialConfig.to) - Date.parse(initialConfig.from)) / 86400000) : '7');
  const [limit, setLimit] = useState(String(initialConfig?.limit || 20));
  const [options, setOptions] = useState<{ platforms: { id: string; label: string }[]; agents: { agentKey: string; name: string; traceCount: number }[] }>({ platforms: [], agents: [] });
  const optionsScope = JSON.stringify([platform, days, apiKey]);
  const [loadedScope, setLoadedScope] = useState('');
  const [loading, setLoading] = useState(false);
  const [serviceState, setServiceState] = useState<'checking' | 'initializing' | 'ready' | 'unavailable'>('checking');
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [externalDeleting, setExternalDeleting] = useState(false);
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const cleanupIntent = useRef<'back' | 'close'>('close');
  const oldId = useRef(replaceId);
  const pending = useRef<{ fingerprint: string; config: GenerationConfig } | null>(null);
  const changeRef = useRef(onChange);
  // 渲染期写 ref 违反 react-hooks/refs（并发渲染下被丢弃的 render 也会写入）。
  // 用 useLayoutEffect 在提交阶段同步：pagehide 处理器与轮询/提交的异步续体
  // 都可能在新状态提交后、passive effect 执行前读取这些 ref。
  useLayoutEffect(() => { currentId.current = id; }, [id]);
  useLayoutEffect(() => { changeRef.current = onChange; });
  useEffect(() => {
    clearTimeout(releaseTimer.current);
    const release = () => {
      const datasetId = currentId.current;
      if (datasetId) void apiFetch(`/api/agent-datasets/${datasetId}/generation`, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('pagehide', release);
      // Defer unmount cleanup so Strict Mode's immediate remount can cancel it.
      releaseTimer.current = setTimeout(release, 0);
    };
  }, []);
  const close = async () => {
    if (busy || externalDeleting) return;
    if (!id) { onClose(); return; }
    setClosing(true); setBusy(true); setError('');
    try {
      const response = await apiFetch(`/api/agent-datasets/${id}/generation`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        const data = await response.json();
        if (!['FEATURE_INITIALIZING', 'FEATURE_UNAVAILABLE'].includes(data.error?.code)) throw new Error(errorText(data, '清理筛选明细失败，请重试'));
      }
      currentId.current = undefined;
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : '关闭失败，请重试'); }
    finally { setClosing(false); setBusy(false); }
  };
  const finishCleanup = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    finishCleanup.current = () => {
      changeRef.current(); setExternalDeleting(false); setCleanupFailed(false);
      const c = progress?.generationConfig;
      if (cleanupIntent.current === 'back' && c) {
        setName(c.name); setDescription(c.description); setPlatform(c.platform); setAgentKey(c.agentKey);
        setDays(String((Date.parse(c.to) - Date.parse(c.from)) / 86400000)); setLimit(String(c.limit));
        setId(undefined); setProgress(null); setLoadedScope(''); pending.current = null;
      } else onClose();
    };
  });
  useEffect(() => {
    if (id || !apiKey) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setError(''); setLoadedScope(''); setServiceState('checking');
    const to = new Date(), from = new Date(to.getTime() - Number(days) * 86400000);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), ...(platform ? { platform } : {}) });
    const load = async () => {
      try {
        const response = await apiFetch(`/api/agent-datasets/generation-options?${params}`, { signal: controller.signal });
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (response.status === 503 && ['FEATURE_INITIALIZING', 'FEATURE_UNAVAILABLE'].includes(data.error?.code)) {
          const initializing = data.error.code === 'FEATURE_INITIALIZING';
          setServiceState(initializing ? 'initializing' : 'unavailable');
          setLoading(initializing); setError(initializing ? '' : errorText(data, '生成服务暂时不可用'));
          timer = setTimeout(() => { void load(); }, initializing ? 2000 : 30000);
          return;
        }
        if (!response.ok) throw new Error(errorText(data, '加载 Agent 失败'));
        setServiceState('ready'); setLoading(false); setError('');
        setOptions(data);
        setLoadedScope(optionsScope);
        setAgentKey(current => data.agents.some((a: { agentKey: string }) => a.agentKey === current) ? current : '');
        if (platform && !data.platforms.some((p: { id: string }) => p.id === platform)) setPlatform('');
      } catch (e) {
        if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : '加载 Agent 失败'); setLoadedScope(''); setLoading(false); setServiceState('checking'); }
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, platform, days, apiKey, optionsScope, optionsAttempt]);
  useEffect(() => {
    if (!id || busy) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await apiFetch(`/api/agent-datasets/${id}/generation`);
        const data = await response.json();
        if (stopped) return;
        if (response.status === 503 && ['FEATURE_INITIALIZING', 'FEATURE_UNAVAILABLE'].includes(data.error?.code)) {
          const initializing = data.error.code === 'FEATURE_INITIALIZING';
          setServiceState(initializing ? 'initializing' : 'unavailable');
          setError(initializing ? '' : errorText(data, '生成服务暂时不可用'));
          timer = setTimeout(poll, initializing ? 2000 : 30000); return;
        }
        if (response.status === 409 && data.error?.code === 'DATASET_DELETING') {
          const deletionResponse = await apiFetch(`/api/agent-datasets/deletions/${data.error.details.deletionId}`);
          const deletion = await deletionResponse.json();
          if (!deletionResponse.ok) throw new Error(errorText(deletion, '读取清理状态失败'));
          if (stopped) return;
          setServiceState('ready');
          setExternalDeleting(deletion.status === 'deleting'); setCleanupFailed(deletion.status === 'cleanup_failed');
          if (deletion.status === 'deleted') { finishCleanup.current(); return; }
          setError(deletion.status === 'cleanup_failed' ? '清理失败，请重试取消或返回' : '');
          timer = setTimeout(poll, 1000); return;
        }
        if (response.status === 404) { finishCleanup.current(); return; }
        if (!response.ok) throw new Error(errorText(data, '读取进度失败'));
        if (stopped) return;
        setServiceState('ready');
        setProgress(previous => ({ ...data, summary: data.summary ?? previous?.summary ?? null })); setError('');
        if (data.status !== 'generating') changeRef.current();
        if (data.status === 'generating') timer = setTimeout(poll, 1000);
      } catch (e) { if (!stopped) { setError(e instanceof Error ? e.message : '读取进度失败'); timer = setTimeout(poll, 2000); } }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, busy]);
  const submit = async () => {
    if (!user || !valid || busy) return;
    setBusy(true); setError('');
    try {
      const fingerprint = JSON.stringify([name, description, platform, agentKey, days, limit]);
      if (pending.current?.fingerprint !== fingerprint) {
        const to = new Date();
        pending.current = { fingerprint, config: { name: name.trim(), description, platform, agentKey, from: new Date(to.getTime() - Number(days) * 86400000).toISOString(), to: to.toISOString(), limit: Number(limit), requestId: uuidv7() } };
      }
      if (oldId.current) { await cleanTraceDataset(oldId.current, user); oldId.current = undefined; changeRef.current(); }
      const response = await apiFetch('/api/agent-datasets/trace-generation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.current.config) });
      const data = await response.json();
      if (response.status === 503 && ['FEATURE_INITIALIZING', 'FEATURE_UNAVAILABLE'].includes(data.error?.code)) {
        setLoadedScope(''); setOptionsAttempt(attempt => attempt + 1);
        return;
      }
      if (!response.ok) throw new Error(errorText(data, '创建任务失败'));
      setId(data.datasetId); setProgress(null); changeRef.current();
    } catch (e) { setError(e instanceof Error ? e.message : '创建任务失败'); } finally { setBusy(false); }
  };
  const cleanup = async (back: boolean) => {
    if (!id || !user) return;
    cleanupIntent.current = back ? 'back' : 'close';
    setBusy(true); setError('');
    try {
      await cleanTraceDataset(id, user, true);
      finishCleanup.current();
    } catch (e) { setError(e instanceof Error ? e.message : '清理失败'); } finally { setBusy(false); }
  };
  const optionsReady = serviceState === 'ready' && loadedScope === optionsScope && !loading;
  const agents = optionsReady ? options.agents : [];
  const valid = Boolean(apiKey && user && name.trim() && name.trim().length <= 50 && platform && agents.some(a => a.agentKey === agentKey) && Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 500 && optionsReady);
  const stopping = (busy && !closing) || externalDeleting;
  const completed = Math.max(0, Math.min(6, progress?.stageIndex || 0));
  const published = progress?.status === 'published';
  const failed = progress?.status === 'failed';
  return <div className={styles.overlay} onClick={() => { void close(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="trace-dataset-title" className={`ai-card ${styles.dialog} ${id ? styles.progressDialog : ''}`} onClick={e => e.stopPropagation()}>
      <header className={styles.header}><h2 id="trace-dataset-title" className="ai-section-title">{id ? '生成评测集' : '基于 Trace 生成评测集'}</h2></header>
      <div className={styles.body}>
      {!apiKey && <p role="alert" style={{ color: 'var(--error)' }}>请重新登录以获取有效凭据</p>}
      {serviceState === 'initializing' && <p role="status" style={{ color: 'var(--foreground-secondary)', marginTop: 12 }}>评测集生成服务正在初始化，完成后将自动恢复，请稍候…</p>}
      {error && <p role="alert" style={{ color: 'var(--error)', marginTop: 12 }}>{error}</p>}
      {!id && error && !optionsReady && <button type="button" className="ai-btn-s" disabled={busy || loading} onClick={() => setOptionsAttempt(attempt => attempt + 1)}>重新加载</button>}
      {!id ? <form onSubmit={e => { e.preventDefault(); void submit(); }} style={{ display: 'grid', gap: 16, marginTop: 20 }}>
        <label>名称 <RequiredMark /><input aria-label="名称" required maxLength={50} style={inputStyle} value={name} onChange={e => setName(e.target.value)} /></label>
        <label>描述<textarea aria-label="描述" maxLength={200} style={inputStyle} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <div className={styles.formGrid}>
          <label>Agent 平台 <RequiredMark /><select aria-label="Agent 平台" required style={inputStyle} value={platform} disabled={busy || serviceState !== 'ready'} onChange={e => { setPlatform(e.target.value); setAgentKey(''); }}><option value="">请选择平台</option>{options.platforms.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
          <label>Agent <RequiredMark /><select aria-label="Agent" required style={inputStyle} value={optionsReady ? agentKey : ''} disabled={!optionsReady || !platform || busy} onChange={e => setAgentKey(e.target.value)}><option value="">{serviceState === 'initializing' ? '服务正在初始化…' : loading ? '加载中…' : error && !optionsReady ? '加载失败，请重新加载' : platform && optionsReady && !agents.length ? '所选时间内没有 Trace' : '请选择 Agent'}</option>{agents.map(a => <option key={a.agentKey} value={a.agentKey}>{a.name}（{a.traceCount} 条 Trace）</option>)}</select></label>
          <label>时间范围<select aria-label="时间范围" style={inputStyle} value={days} disabled={busy} onChange={e => { setDays(e.target.value); setAgentKey(''); }}><option value="1">最近24小时</option><option value="7">最近7天</option><option value="30">最近30天</option></select></label>
          <label>生成条数上限 <RequiredMark /><input aria-label="生成条数上限" type="number" min={1} max={500} step={1} required value={limit} style={inputStyle} onChange={e => setLimit(e.target.value)} /></label>
        </div>
        <div><h3 className="ai-section-title">理想输出评测集</h3><table style={{ width: '100%', marginTop: 10 }}><thead><tr><th align="left">字段名</th><th align="left">类型</th><th align="left">必填</th></tr></thead><tbody>{['input', 'reference_output'].map(key => <tr key={key}><td style={{ padding: '8px 0' }}>{key}</td><td>String</td><td>是</td></tr>)}</tbody></table></div>
        <footer className={styles.footer}><button type="button" className="ai-btn-s" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="ai-btn-p" disabled={!valid || busy}>{busy ? '提交中…' : '开始生成'}</button></footer>
      </form> : <div>
        <div className={styles.progressTitle}><span>{name}</span><span className={`${styles.badge} ${published ? styles.success : failed ? styles.failure : styles.generating}`}>{published ? '已发布' : failed ? '异常' : '生成中'}</span></div>
        <p className={styles.summary} role="status">{stopping ? '正在停止并清理…' : cleanupFailed ? '清理失败，请重试' : published ? <>已生成 <strong>{progress.generatedCount}</strong> 条数据</> : failed ? '生成失败' : !progress ? '读取进度…' : progress.stage === 'queued' ? '排队中，等待开始生成…' : '正在生成评测数据集…'}</p>
        {progress?.error ? <div role="alert" className={styles.errorDetail}><strong>{progress.error.code}</strong><p>{progress.error.message}</p></div> : <div role="progressbar" aria-label="生成阶段" aria-valuemin={0} aria-valuemax={6} aria-valuenow={completed} aria-valuetext={`已完成 ${completed} / 6 个阶段`} className={styles.bar}><span style={{ width: `${completed / 6 * 100}%`, background: published ? 'var(--success)' : 'var(--primary)' }} /></div>}
        <ol className={styles.stages} aria-label="生成步骤">
          {generationStages.map((stage, index) => {
            const done = index < completed;
            const current = index === completed && !!progress && progress.stage !== 'queued' && !published;
            const running = current && !failed && !stopping && !cleanupFailed;
            const stageStatus = done ? '已完成' : current && stopping ? '正在停止' : current && failed ? '失败' : running ? '处理中' : '等待';
            return <li key={stage} className={`${styles.stage} ${done ? styles.done : running ? styles.running : current && failed ? styles.failed : ''}`} aria-current={current ? 'step' : undefined}>
              <span className={styles.stepNumber} aria-hidden="true">{done ? <Check size={14} /> : index + 1}</span>
              <h3>{STAGE_LABELS[stage]}</h3><span className={styles.stageStatus}>{stageStatus}</span>
            </li>;
          })}
        </ol>
        {progress?.summary ? <section aria-label="筛选明细" className={styles.filterSummary}>
          <h3>筛选明细</h3>
          <p className={styles.tip}>筛选明细仅供本次查看，关闭窗口后不再保留。</p>
          <p>读取 {progress.summary.sourceTraces} 条 Trace，其中 {progress.summary.retainedTraces} 条提取到有效样本，共 {progress.summary.candidateCount} 条候选。</p>
          <p>去除重复 {progress.summary.duplicateCount} 条{progress.summary.sampledOutCount !== null ? `，因生成上限未选入 ${progress.summary.sampledOutCount} 条` : ''}。生成条数上限不代表保证生成数量。</p>
          {progress.summary.exclusions.length > 0 && <><ul>{progress.summary.exclusions.map(reason => {
            const detail = EXCLUSION_REASONS[reason.code];
            return <li key={reason.code}><strong>{detail?.label || '无法提取样本'}</strong>（涉及 {reason.traceCount} 条 Trace{reason.turnCount > 0 ? `，跳过 ${reason.turnCount} 轮` : ''}）<p>{detail?.explanation || '来源未满足提取条件。'}</p></li>;
          })}</ul><p className={styles.tip}>同一条 Trace 可同时保留有效轮次、跳过其他轮次；各原因涉及的 Trace 数可能重叠。</p></>}
        </section> : (published || failed) && <p className={styles.tip}>筛选明细未持久保存，当前已不可用；如需查看，请重新生成。</p>}
        <footer className={styles.footer}>
          <button className="ai-btn-s" disabled={serviceState !== 'ready' || busy || externalDeleting || (!cleanupFailed && !progress?.canCancel)} onClick={() => void cleanup(false)}>取消</button>
          {progress?.canReturn && <button className="ai-btn-s" disabled={serviceState !== 'ready' || busy || externalDeleting} onClick={() => void cleanup(true)}>返回</button>}
          <button className="ai-btn-p" disabled={serviceState !== 'ready' || busy || externalDeleting || !progress?.canFinish} onClick={() => void close()}>完成</button>
        </footer>
      </div>}
      </div>
    </section>
  </div>;
}
