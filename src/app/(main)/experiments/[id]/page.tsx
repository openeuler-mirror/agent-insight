'use client';

// 单组实验详情正式版：状态条 → 整体表现（综合均分）→ 评估器分解（单色条 + N/M 计入）
// → Case 明细表（综合/结果/轨迹得分 + sticky 操作列：详情 / 重评失败行）。
// 聚合口径统一走 src/lib/engine/experiment/detail-agg.ts（有分才入均分）。
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';

import { useEvaluatorLookup } from '@/components/eval/useEvaluatorLookup';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import {
  caseScore,
  evaluatorBreakdown,
  overallAverage,
} from '@/lib/engine/experiment/detail-agg';

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
const CARD: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10,
};

function truncate(text: string | null | undefined, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function fmtScore(v: number | null): string {
  return typeof v === 'number' ? String(v) : '—';
}

const PAGE_SIZE = 10;

export default function ExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useAuth();
  const lookup = useEvaluatorLookup(user);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [retryingCaseId, setRetryingCaseId] = useState('');
  const [page, setPage] = useState(1);

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

  // 重评：逐行重试该 case 下所有 failed 结果行
  const retryCase = useCallback(async (caseId: string) => {
    if (!user || retryingCaseId || !detail) return;
    const failedRows = detail.results.filter((r) => r.caseId === caseId && r.status === 'failed');
    if (!failedRows.length) return;
    setRetryingCaseId(caseId);
    try {
      for (const row of failedRows) {
        const res = await apiFetch(
          `/api/experiments/${encodeURIComponent(id)}/results/${encodeURIComponent(row.id)}/retry?user=${encodeURIComponent(user)}`,
          { method: 'POST' },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(String(data?.error || '重评失败'));
      }
      await load(true);
    } catch (e: any) {
      setError(e?.message || '重评失败');
    } finally {
      setRetryingCaseId('');
    }
  }, [user, id, retryingCaseId, detail, load]);

  const status = STATUS_META[detail?.status ?? 'draft'] ?? STATUS_META.draft;

  const overall = useMemo(
    () => (detail ? overallAverage(detail.results) : null),
    [detail],
  );
  const breakdown = useMemo(
    () => (detail ? evaluatorBreakdown(detail.results) : []),
    [detail],
  );
  const caseRows = useMemo(() => {
    if (!detail) return [];
    return detail.cases.map((c) => ({
      ...c,
      scores: caseScore(detail.results.filter((r) => r.caseId === c.id), lookup.categoryOf),
    }));
  }, [detail, lookup]);

  const totalPages = Math.max(1, Math.ceil(caseRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRows = caseRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <>
      <AppTopBar title={detail ? detail.name : '实验详情'} />
      <PageContainer>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>加载中…</div>
        ) : error && !detail ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--error)' }}>{error}</div>
        ) : !detail ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--error)' }}>实验不存在</div>
        ) : (
          <>
            {error && (
              <div style={{ ...CARD, padding: 10, marginBottom: 12, fontSize: 12, color: 'var(--error)' }}>{error}</div>
            )}

            {/* 顶部状态条 */}
            <div style={{
              ...CARD, padding: 16, marginBottom: 14,
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

            {/* 整体表现卡（整行） */}
            <div style={{ ...CARD, padding: '18px 20px', marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground-secondary)', marginBottom: 8 }}>
                整体表现 · {detail.cases.length} 个 case
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, color: 'var(--accent)' }}>
                  {fmtScore(overall)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>综合均分（仅计入评估成功且有分的结果）</span>
              </div>
            </div>

            {/* 评估器分解 */}
            {breakdown.length > 0 && (
              <div style={{ ...CARD, marginBottom: 14 }}>
                <div style={{
                  padding: '11px 16px', borderBottom: '1px solid var(--border)',
                  fontSize: 12.5, fontWeight: 600,
                }}>
                  评估器分解
                </div>
                <div style={{ padding: '12px 16px', display: 'grid', gap: 12 }}>
                  {breakdown.map((row) => (
                    <div key={row.evaluatorId} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 240, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {lookup.nameOf(row.evaluatorId)}
                        </div>
                        <div style={{ fontSize: 10.5, color: 'var(--foreground-muted)', marginTop: 2 }}>
                          {lookup.tagsOf(row.evaluatorId).join(' · ') || row.evaluatorId}
                        </div>
                      </div>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ flex: 1, height: 8, borderRadius: 5, background: 'var(--background-secondary)', overflow: 'hidden' }}>
                          <div style={{
                            width: `${row.avg ?? 0}%`, height: '100%', borderRadius: 5,
                            background: 'var(--accent)',
                          }} />
                        </div>
                        <span style={{ width: 44, textAlign: 'right', fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
                          {fmtScore(row.avg)}
                        </span>
                      </div>
                      <span style={{ width: 90, fontSize: 10.5, color: 'var(--foreground-muted)', textAlign: 'right' }}>
                        {row.scored}/{row.total} 项计入
                        {row.failed > 0 && (
                          <span style={{ display: 'block', color: 'var(--error)' }}>{row.failed} 项评估失败</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Case 明细表 */}
            <div style={{ ...CARD, overflow: 'hidden' }}>
              <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', fontSize: 12.5, fontWeight: 600 }}>
                Case 明细
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
                  <thead>
                    <tr>
                      <th style={TH}>输入</th>
                      <th style={TH}>参考输出</th>
                      <th style={TH}>实际输出</th>
                      <th style={{ ...TH, width: 72 }}>综合得分</th>
                      <th style={{ ...TH, width: 72 }}>结果得分</th>
                      <th style={{ ...TH, width: 72 }}>轨迹得分</th>
                      <th style={{ ...TH, position: 'sticky', right: 0, background: 'var(--card-bg)', boxShadow: '-6px 0 8px -6px rgba(0,0,0,.18)' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map((c) => (
                      <tr key={c.id}>
                        <td style={{ ...TD, maxWidth: 280 }}>{truncate(c.input, 80)}</td>
                        <td style={{ ...TD, maxWidth: 220 }}>
                          {c.referenceOutput
                            ? truncate(c.referenceOutput, 60)
                            : <span style={{ color: 'var(--foreground-muted)', fontSize: 11 }}>未标注</span>}
                        </td>
                        <td style={{ ...TD, maxWidth: 280, color: 'var(--foreground-secondary)' }}>
                          {truncate(c.actualOutput, 80)}
                        </td>
                        <td style={{ ...TD, fontWeight: 700 }}>{fmtScore(c.scores.overall)}</td>
                        <td style={TD}>{fmtScore(c.scores.res)}</td>
                        <td style={TD}>{fmtScore(c.scores.traj)}</td>
                        <td style={{
                          ...TD, whiteSpace: 'nowrap', position: 'sticky', right: 0,
                          background: 'var(--card-bg)', boxShadow: '-6px 0 8px -6px rgba(0,0,0,.18)',
                        }}>
                          <Link
                            href={`/experiments/${encodeURIComponent(id)}/cases/${encodeURIComponent(c.id)}`}
                            style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', marginRight: 10 }}
                          >
                            详情
                          </Link>
                          {c.scores.failed > 0 && (
                            <button
                              onClick={() => retryCase(c.id)}
                              disabled={!!retryingCaseId}
                              style={{
                                fontSize: 11, padding: '2px 9px', borderRadius: 6,
                                border: '1px solid var(--border)', background: 'var(--background-secondary)',
                                color: 'var(--foreground)', cursor: retryingCaseId ? 'default' : 'pointer',
                                opacity: retryingCaseId && retryingCaseId !== c.id ? 0.5 : 1,
                              }}
                            >
                              {retryingCaseId === c.id ? '重评中…' : '重评'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {pagedRows.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ ...TD, textAlign: 'center', color: 'var(--foreground-muted)' }}>暂无 case</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {caseRows.length > PAGE_SIZE && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px',
                  borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--foreground-muted)',
                }}>
                  共 {caseRows.length} 个 case · 每页 {PAGE_SIZE} 条
                  <span style={{ flex: 1 }} />
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    style={{
                      fontSize: 11, padding: '2px 9px', borderRadius: 6, border: '1px solid var(--border)',
                      background: 'var(--background-secondary)', color: 'var(--foreground)',
                      cursor: safePage <= 1 ? 'default' : 'pointer', opacity: safePage <= 1 ? 0.5 : 1,
                    }}
                  >
                    上一页
                  </button>
                  <span>{safePage} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    style={{
                      fontSize: 11, padding: '2px 9px', borderRadius: 6, border: '1px solid var(--border)',
                      background: 'var(--background-secondary)', color: 'var(--foreground)',
                      cursor: safePage >= totalPages ? 'default' : 'pointer', opacity: safePage >= totalPages ? 0.5 : 1,
                    }}
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </PageContainer>
    </>
  );
}
