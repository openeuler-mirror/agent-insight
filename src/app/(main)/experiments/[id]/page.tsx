'use client';

// TODO(M6): 实验详情页最小壳 —— 执行引擎与结果呈现（ExperimentEvalResult）
// 落地后本页会重做为「按评估器 × case 的结果矩阵 + 类目均分」形态。
import { use, useCallback, useEffect, useState } from 'react';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';

interface ExperimentDetail {
  id: string;
  name: string;
  type: string;
  agentName: string;
  status: string;
  evaluatorIds: string[];
  createdAt: string;
  cases: Array<{
    id: string;
    executionId: string | null;
    taskId: string | null;
    input: string;
    actualOutput: string;
    referenceOutput: string | null;
  }>;
  results: Array<{
    id: string;
    caseId: string;
    evaluatorId: string;
    status: string;
    score: number | null;
    points: unknown;
    evidence: unknown;
    errorMessage: string | null;
    attempts: number;
    durationMs: number | null;
  }>;
  progress: { total: number; done: number; failed: number; pending: number };
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  draft: { label: '草稿', bg: 'var(--background-secondary)', fg: 'var(--foreground-secondary)' },
  running: { label: '运行中', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
  done: { label: '已完成', bg: 'var(--tag-green-bg)', fg: 'var(--tag-green-fg)' },
  failed: { label: '失败', bg: 'var(--tag-red-bg)', fg: 'var(--tag-red-fg)' },
};

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '9px 12px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
};

function truncate(text: string | null | undefined, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export default function ExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [retryingId, setRetryingId] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!user) return;
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch(`/api/experiments/${encodeURIComponent(id)}?user=${encodeURIComponent(user)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '加载实验失败'));
      setDetail(data);
      setError('');
    } catch (e: any) {
      if (!silent) {
        setError(e?.message || '加载实验失败');
        setDetail(null);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [user, id]);

  useEffect(() => { load(); }, [load]);

  // running 时 5s 轮询进度
  useEffect(() => {
    if (detail?.status !== 'running') return;
    const timer = setInterval(() => { load(true); }, 5000);
    return () => clearInterval(timer);
  }, [detail?.status, load]);

  const startRun = useCallback(async () => {
    if (!user || starting) return;
    setStarting(true);
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}/run?user=${encodeURIComponent(user)}`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '启动执行失败'));
      await load(true);
    } catch (e: any) {
      setError(e?.message || '启动执行失败');
    } finally {
      setStarting(false);
    }
  }, [user, id, starting, load]);

  const retryResult = useCallback(async (resultId: string) => {
    if (!user || retryingId) return;
    setRetryingId(resultId);
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}/results/${encodeURIComponent(resultId)}/retry?user=${encodeURIComponent(user)}`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '重评失败'));
      await load(true);
    } catch (e: any) {
      setError(e?.message || '重评失败');
    } finally {
      setRetryingId('');
    }
  }, [user, id, retryingId, load]);

  const status = STATUS_META[detail?.status ?? 'draft'] ?? STATUS_META.draft;

  return (
    <>
      <AppTopBar title={detail ? detail.name : '实验详情'} />
      <PageContainer>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>加载中…</div>
        ) : error || !detail ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--error)' }}>{error || '实验不存在'}</div>
        ) : (
          <>
            <div style={{
              background: 'var(--card-bg)', border: '1px solid var(--card-border)',
              borderRadius: 10, padding: 16, marginBottom: 14,
              display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', fontSize: 12,
            }}>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 500,
                background: status.bg, color: status.fg,
              }}>
                {status.label}
              </span>
              <span><span style={{ color: 'var(--foreground-muted)' }}>待评测 Agent：</span>{detail.agentName || '—'}</span>
              <span><span style={{ color: 'var(--foreground-muted)' }}>Case：</span>{detail.cases.length}</span>
              <span><span style={{ color: 'var(--foreground-muted)' }}>评估器：</span>{detail.evaluatorIds.length}</span>
              <span style={{ color: 'var(--foreground-muted)' }}>
                创建于 {new Date(detail.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
              {detail.progress?.total > 0 && (
                <span>
                  <span style={{ color: 'var(--foreground-muted)' }}>进度：</span>
                  {detail.progress.done} 完成 / {detail.progress.failed} 失败 / {detail.progress.pending} 待执行
                </span>
              )}
              {detail.status === 'draft' && (
                <button
                  onClick={startRun}
                  disabled={starting}
                  style={{
                    marginLeft: 'auto', fontSize: 12, padding: '5px 14px', borderRadius: 7,
                    border: '1px solid var(--border)', background: 'var(--accent)',
                    color: '#fff', cursor: starting ? 'default' : 'pointer', opacity: starting ? 0.6 : 1,
                  }}
                >
                  {starting ? '启动中…' : '开始执行'}
                </button>
              )}
            </div>

            <div style={{
              background: 'var(--card-bg)', border: '1px solid var(--card-border)',
              borderRadius: 10, overflow: 'hidden',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={TH}>任务输入</th>
                    <th style={TH}>参考输出</th>
                    <th style={TH}>实际输出</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.cases.map((c) => (
                    <tr key={c.id}>
                      <td style={{ ...TD, maxWidth: 320 }}>{truncate(c.input, 90)}</td>
                      <td style={TD}>
                        <span style={{
                          fontSize: 11, padding: '1px 7px', borderRadius: 8, fontWeight: 500,
                          background: c.referenceOutput ? 'var(--tag-green-bg)' : 'var(--background-secondary)',
                          color: c.referenceOutput ? 'var(--tag-green-fg)' : 'var(--foreground-muted)',
                        }}>
                          {c.referenceOutput ? '已标注' : '未标注'}
                        </span>
                      </td>
                      <td style={{ ...TD, maxWidth: 380, color: 'var(--foreground-secondary)' }}>
                        {truncate(c.actualOutput, 110)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {detail.results.length > 0 && (
              <div style={{
                background: 'var(--card-bg)', border: '1px solid var(--card-border)',
                borderRadius: 10, overflow: 'hidden', marginTop: 14,
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={TH}>Case</th>
                      <th style={TH}>评估器</th>
                      <th style={TH}>状态</th>
                      <th style={TH}>得分</th>
                      <th style={TH}>说明</th>
                      <th style={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.results.map((r) => {
                      const caseRow = detail.cases.find((c) => c.id === r.caseId);
                      const rs = STATUS_META[r.status === 'pending' || r.status === 'running' ? 'running' : r.status] ?? STATUS_META.draft;
                      return (
                        <tr key={r.id}>
                          <td style={{ ...TD, maxWidth: 240 }}>{truncate(caseRow?.input, 60)}</td>
                          <td style={TD}>{r.evaluatorId}</td>
                          <td style={TD}>
                            <span style={{
                              fontSize: 11, padding: '1px 7px', borderRadius: 8, fontWeight: 500,
                              background: rs.bg, color: rs.fg,
                            }}>
                              {r.status === 'pending' ? '待执行' : r.status === 'running' ? '执行中' : rs.label}
                            </span>
                          </td>
                          <td style={TD}>{typeof r.score === 'number' ? r.score : '—'}</td>
                          <td style={{ ...TD, maxWidth: 320, color: r.errorMessage ? 'var(--error)' : 'var(--foreground-secondary)' }}>
                            {truncate(r.errorMessage, 90)}
                          </td>
                          <td style={TD}>
                            {r.status === 'failed' && (
                              <button
                                onClick={() => retryResult(r.id)}
                                disabled={!!retryingId}
                                style={{
                                  fontSize: 11, padding: '3px 10px', borderRadius: 6,
                                  border: '1px solid var(--border)', background: 'var(--background-secondary)',
                                  color: 'var(--foreground)', cursor: retryingId ? 'default' : 'pointer',
                                  opacity: retryingId && retryingId !== r.id ? 0.5 : 1,
                                }}
                              >
                                {retryingId === r.id ? '重评中…' : '重评'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </PageContainer>
    </>
  );
}
