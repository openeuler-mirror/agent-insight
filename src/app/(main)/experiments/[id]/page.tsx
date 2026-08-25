'use client';

// 单组实验详情正式版：状态条 → 整体表现（综合均分）→ 评估器分解（单色条 + N/M 计入）
// → Case 明细表（综合/结果/轨迹得分 + sticky 操作列：详情 / 统一重试）→ 实验级评论。
// 聚合口径统一走 src/lib/engine/experiment/detail-agg.ts（有分才入均分，分 = humanScore ?? score）。
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AddExperimentCasesDialog } from '@/components/eval/AddExperimentCasesDialog';
import { EvalComments, filterComments, type EvalCommentRow } from '@/components/eval/EvalComments';
import { useEvaluatorLookup } from '@/components/eval/useEvaluatorLookup';
import { ComparisonDetail } from '@/components/eval/ComparisonDetail';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { caseScore, type EvaluatorBreakdownRow } from '@/lib/engine/experiment/detail-agg';

interface ExperimentDetail {
  id: string;
  name: string;
  type: string;
  agentName: string;
  status: string;
  preset?: string | null;
  watchMode?: boolean;
  watchEnabledAt?: string | null;
  evaluatorIds: string[];
  createdAt: string;
  cases: Array<{
    id: string;
    executionId: string | null;
    taskId: string | null;
    input: string;
    actualOutput: string;
    referenceOutput: string | null;
    traceStatus: 'pending' | 'ready' | 'failed' | null;
    traceError: string | null;
    traceAttemptNo: number | null;
    traceAttemptStatus: string | null;
  }>;
  results: Array<{
    id: string;
    caseId: string;
    evaluatorId: string;
    status: string;
    score: number | null;
    points: unknown;
    evidence: unknown;
    humanScore: number | null;
    errorMessage: string | null;
    attempts: number;
    durationMs: number | null;
  }>;
  progress: { total: number; done: number; failed: number; pending: number };
  traceProgress: { total: number; ready: number; failed: number; pending: number } | null;
  overall: number | null;
  breakdown: EvaluatorBreakdownRow[];
  caseTotal: number;
  casePage: number;
  casePageSize: number;
}

const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  draft: { label: '运行中', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
  running: { label: '运行中', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
  done: { label: '已完成', bg: 'var(--tag-green-bg)', fg: 'var(--tag-green-fg)' },
  failed: { label: '失败', bg: 'var(--tag-red-bg)', fg: 'var(--tag-red-fg)' },
};

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const STICKY_TH: React.CSSProperties = {
  ...TH, position: 'sticky', top: 0, zIndex: 1, background: 'var(--card-bg)',
};
const TD: React.CSSProperties = {
  padding: '9px 12px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
};
// 操作列按钮：详情/重试同尺寸同形状，只用颜色区分主次
const ACTION_BTN: React.CSSProperties = {
  fontSize: 11.5, padding: '3px 10px', borderRadius: 6, lineHeight: 1.5,
  border: '1px solid var(--border)', background: 'var(--card-bg)',
  cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap',
  display: 'inline-flex', alignItems: 'center',
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const CASE_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function ExperimentDetail({
  id,
  embedded = false,
  onBack,
  onOpenCase,
}: {
  id: string;
  embedded?: boolean;
  onBack?: () => void;
  onOpenCase?: (caseId: string) => void;
}) {
  const { user } = useAuth();
  const lookup = useEvaluatorLookup(user);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retryingCaseId, setRetryingCaseId] = useState('');
  const [casePage, setCasePage] = useState(1);
  const [casePageSize, setCasePageSize] = useState(20);
  const [addCasesOpen, setAddCasesOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [comments, setComments] = useState<EvalCommentRow[]>([]);
  const loadSequence = useRef(0);

  const loadComments = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}/comments?user=${encodeURIComponent(user)}&scope=all`,
      );
      const data = await res.json();
      setComments(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setComments([]);
    }
  }, [user, id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadComments(), 0);
    return () => window.clearTimeout(timer);
  }, [loadComments]);

  const load = useCallback(async (silent = false) => {
    if (!user) return;
    const sequence = ++loadSequence.current;
    if (!silent) setLoading(true);
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}?user=${encodeURIComponent(user)}&casePage=${casePage}&casePageSize=${casePageSize}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '加载实验失败'));
      if (sequence !== loadSequence.current) return;
      setDetail(data);
      setError('');
    } catch (e: unknown) {
      if (!silent && sequence === loadSequence.current) {
        setError(errorMessage(e, '加载实验失败'));
        setDetail(null);
      }
    } finally {
      if (!silent && sequence === loadSequence.current) setLoading(false);
    }
  }, [user, id, casePage, casePageSize]);

  useEffect(() => () => { loadSequence.current += 1; }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // 运行中或仍有未收敛子任务时持续轮询；串行发请求，避免旧响应覆盖新快照。
  useEffect(() => {
    if (!detail || (detail.status !== 'running' && detail.progress.pending === 0 && !detail.traceProgress?.pending)) return;
    let cancelled = false;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await load(true);
        if (!cancelled) schedule();
      }, 5000);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [detail, load]);

  // 同一入口由服务端判断：Trace 未生成则重跑并绑定；否则重试失败的评估行。
  const retryCase = useCallback(async (caseId: string) => {
    if (!user || retryingCaseId || !detail) return;
    setRetryingCaseId(caseId);
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}/cases/${encodeURIComponent(caseId)}/retry?user=${encodeURIComponent(user)}`,
        { method: 'POST' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '重试失败'));
      await load(true);
    } catch (e: unknown) {
      setError(errorMessage(e, '重试失败'));
    } finally {
      setRetryingCaseId('');
    }
  }, [user, id, retryingCaseId, detail, load]);

  const [stoppingWatch, setStoppingWatch] = useState(false);
  const stopWatch = useCallback(async () => {
    if (!user || stoppingWatch) return;
    if (!window.confirm('停止监听后，该 Agent 后续新上报的 trace 将不再自动进本实验评测（已评结果全部保留）。确认停止？')) return;
    setStoppingWatch(true);
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, watchMode: false }) },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '停止监听失败'));
      await load(true);
    } catch (e: unknown) {
      setError(errorMessage(e, '停止监听失败'));
    } finally {
      setStoppingWatch(false);
    }
  }, [user, id, stoppingWatch, load]);

  const status = STATUS_META[detail?.status ?? 'draft'] ?? STATUS_META.draft;

  // 聚合口径（整体均分/评估器分解）由服务端按全量结果算好返回
  const overall = detail?.overall ?? null;
  const breakdown = detail?.breakdown ?? [];
  // caseRows = 当前页 case（服务端已分页）+ 逐 case 得分（用本页结果算）
  // 对比模式（type='llm'）不走 caseRows——ComparisonDetail 自带 pairing 数据；guard 避免 undefined.map()
  const caseRows = useMemo(() => {
    if (!detail || detail.type === 'llm' || !detail.cases || !detail.results) return [];
    return detail.cases.map((c) => ({
      ...c,
      scores: caseScore(detail.results.filter((r) => r.caseId === c.id), lookup.categoryOf),
    }));
  }, [detail, lookup]);

  // 本实验是否含依赖参考数据的评估器——新增 case 时据此提示"不标注参考答案会不记分"
  const needsReference = useMemo(
    () => (detail?.evaluatorIds ?? []).some((eid) => lookup.requiresReference(eid)),
    [detail, lookup],
  );

  const caseTotal = detail?.caseTotal ?? 0;
  const totalPages = Math.max(1, Math.ceil(caseTotal / casePageSize));
  const pagedRows = caseRows;
  // 服务端页码越界（如减小每页条数后当前页超出）时回夹到末页
  useEffect(() => {
    if (casePage <= totalPages) return;
    const timer = window.setTimeout(() => setCasePage(totalPages), 0);
    return () => window.clearTimeout(timer);
  }, [casePage, totalPages]);

  return (
    <>
      {!embedded && <AppTopBar title={detail ? detail.name : '实验详情'} />}
      <PageContainer
        variant={embedded ? 'canvas' : 'default'}
        className={embedded ? 'overflow-visible [&>*]:shrink-0' : '[&>*]:shrink-0'}
      >
        {embedded && onBack && (
          <button type="button" onClick={onBack} style={{ ...ACTION_BTN, marginBottom: 12 }}>‹ 返回实验记录</button>
        )}
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>加载中…</div>
        ) : error && !detail ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--error)' }}>{error}</div>
        ) : !detail ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--error)' }}>实验不存在</div>
        ) : detail.type === 'llm' ? (
          <>
            {error && (
              <div style={{ ...CARD, padding: 10, marginBottom: 12, fontSize: 12, color: 'var(--error)' }}>{error}</div>
            )}
            <ComparisonDetail detail={detail as unknown as import('@/lib/engine/experiment/comparison-runner').ComparisonDetailData} />
          </>
        ) : (
          <>
            {error && (
              <div style={{ ...CARD, padding: 10, marginBottom: 12, fontSize: 12, color: 'var(--error)' }}>{error}</div>
            )}

            {/* 监听中横幅 */}
            {detail.watchMode && (
              <div style={{
                ...CARD, padding: '12px 16px', marginBottom: 14,
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12,
                background: 'var(--tag-green-bg)', borderColor: 'var(--tag-green-fg)',
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: 'var(--tag-green-fg)',
                  display: 'inline-block', flex: '0 0 auto',
                }} />
                <span style={{ fontWeight: 600, color: 'var(--tag-green-fg)' }}>监听中</span>
                <span style={{ color: 'var(--foreground-secondary)' }}>
                  Agent <b style={{ color: 'var(--foreground)' }}>{detail.agentName || '—'}</b> 新上报的 trace 会自动进本实验评测
                  {detail.watchEnabledAt && `（自 ${new Date(detail.watchEnabledAt).toLocaleString('zh-CN', { hour12: false })} 起）`}
                </span>
                <button
                  onClick={stopWatch}
                  disabled={stoppingWatch}
                  style={{
                    marginLeft: 'auto', fontSize: 12, padding: '5px 14px', borderRadius: 7,
                    border: '1px solid var(--tag-green-fg)', background: 'var(--card-bg)',
                    color: 'var(--tag-green-fg)', cursor: stoppingWatch ? 'default' : 'pointer',
                    opacity: stoppingWatch ? 0.6 : 1, fontWeight: 600, whiteSpace: 'nowrap',
                  }}
                >
                  {stoppingWatch ? '停止中…' : '停止监听'}
                </button>
              </div>
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
              <span><span style={{ color: 'var(--foreground-muted)' }}>Case：</span>{detail.caseTotal}</span>
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
              {detail.traceProgress && (
                <span>
                  <span style={{ color: 'var(--foreground-muted)' }}>Trace：</span>
                  {detail.traceProgress.ready} 已生成 / {detail.traceProgress.failed} 失败 / {detail.traceProgress.pending} 生成中
                </span>
              )}
            </div>

            {detail.traceProgress && detail.traceProgress.failed > 0 && (
              <div style={{
                ...CARD, padding: '10px 14px', marginBottom: 14, fontSize: 12,
                background: 'var(--tag-red-bg)', color: 'var(--tag-red-fg)',
              }}>
                {detail.traceProgress.failed} 个 Case 未生成有效 Trace，已跳过评估且不计入综合得分。
                {detail.traceProgress.ready > 0 && ` 其余 ${detail.traceProgress.ready} 个 Case 正常评估。`}
              </div>
            )}

            {/* 整体表现卡（整行） */}
            <div style={{ ...CARD, padding: '18px 20px', marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground-secondary)', marginBottom: 8 }}>
                整体表现 · {detail.caseTotal} 个 case
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
                          {detail.preset === 'trigger'
                              ? ({
                                'skill-trigger-analyzer': 'skill-trigger-analyzer',
                                'skill-trigger-accuracy': 'skill-trigger-analyzer（历史结果）',
                                'preset-agent-task-completion': 'skill-trigger-analyzer（历史结果）',
                                'preset-result-accuracy': 'skill-trigger-analyzer（历史结果）',
                              }[row.evaluatorId] || lookup.nameOf(row.evaluatorId))
                            : lookup.nameOf(row.evaluatorId)}
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
                        {row.adjusted > 0 && (
                          <span style={{ display: 'block', color: 'var(--warning)' }}>{row.adjusted} 项人工修正</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Case 明细表 */}
            <div style={{ ...CARD, overflow: 'hidden' }}>
              <div style={{
                padding: '11px 16px', borderBottom: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>Case 明细</span>
                {notice && (
                  <span style={{ fontSize: 11.5, color: 'var(--success, var(--accent))' }}>{notice}</span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  onClick={() => { setNotice(''); setAddCasesOpen(true); }}
                  style={{
                    ...ACTION_BTN, color: 'var(--accent)', borderColor: 'var(--accent)', fontWeight: 600,
                  }}
                >
                  + 新增 Case
                </button>
              </div>
              <div style={{ maxHeight: 'min(42vh, 420px)', overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
                  <thead>
                    <tr>
                      <th style={STICKY_TH}>输入</th>
                      <th style={STICKY_TH}>参考输出</th>
                      <th style={STICKY_TH}>实际输出</th>
                      <th style={{ ...STICKY_TH, width: 72 }}>综合得分</th>
                      <th style={{ ...STICKY_TH, width: 72 }}>结果得分</th>
                      <th style={{ ...STICKY_TH, width: 72 }}>轨迹得分</th>
                      <th style={{ ...STICKY_TH, width: 128, textAlign: 'center', right: 0, zIndex: 2, boxShadow: '-6px 0 8px -6px rgba(0,0,0,.18)' }}>操作</th>
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
                          {c.traceStatus === 'failed' ? (
                            <span title={c.traceError || undefined} style={{ color: 'var(--error)', fontSize: 11 }}>
                              Trace 生成失败{c.traceAttemptNo ? `（已尝试 ${c.traceAttemptNo} 次）` : ''}
                            </span>
                          ) : c.traceStatus === 'pending' ? (
                            <span style={{ color: 'var(--warning)', fontSize: 11 }}>
                              正在生成 Trace{c.traceAttemptNo ? `（第 ${c.traceAttemptNo} 次）` : ''}…
                            </span>
                          ) : c.traceStatus === 'ready' && !c.actualOutput ? (
                            <span style={{ color: 'var(--foreground-muted)', fontSize: 11 }}>Trace 已生成（无最终输出）</span>
                          ) : truncate(c.actualOutput, 80)}
                        </td>
                        <td style={{ ...TD, fontWeight: 700 }}>
                          {fmtScore(c.scores.overall)}
                          {c.scores.adjusted > 0 && (
                            <span
                              title={`${c.scores.adjusted} 项评估被人工修正，该分数按人工分算`}
                              style={{ marginLeft: 4, fontSize: 10, fontWeight: 600, color: 'var(--warning)' }}
                            >
                              人工
                            </span>
                          )}
                        </td>
                        <td style={TD}>{fmtScore(c.scores.res)}</td>
                        <td style={TD}>{fmtScore(c.scores.traj)}</td>
                        <td style={{
                          ...TD, width: 128, whiteSpace: 'nowrap', position: 'sticky', right: 0,
                          background: 'var(--card-bg)', boxShadow: '-6px 0 8px -6px rgba(0,0,0,.18)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                            {embedded && onOpenCase ? (
                              <button
                                type="button"
                                onClick={() => onOpenCase(c.id)}
                                style={{ ...ACTION_BTN, color: 'var(--accent)', borderColor: 'var(--accent)' }}
                              >
                                详情
                              </button>
                            ) : (
                              <Link
                                href={`/experiments/${encodeURIComponent(id)}/cases/${encodeURIComponent(c.id)}`}
                                style={{ ...ACTION_BTN, color: 'var(--accent)', borderColor: 'var(--accent)' }}
                              >
                                详情
                              </Link>
                            )}
                            {(c.traceStatus === 'failed' || c.scores.failed > 0) && (
                              <button
                                onClick={() => retryCase(c.id)}
                                disabled={!!retryingCaseId}
                                style={{
                                  ...ACTION_BTN, color: 'var(--foreground)',
                                  cursor: retryingCaseId ? 'default' : 'pointer',
                                  opacity: retryingCaseId && retryingCaseId !== c.id ? 0.5 : 1,
                                }}
                              >
                                {retryingCaseId === c.id ? '重试中…' : '重试'}
                              </button>
                            )}
                          </div>
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
              {caseTotal > casePageSize && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px',
                  borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--foreground-muted)',
                }}>
                  共 {caseTotal} 个 case
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 6 }}>
                    每页
                    <select
                      value={casePageSize}
                      onChange={(e) => { setCasePageSize(Number(e.target.value)); setCasePage(1); }}
                      style={{
                        fontSize: 11, padding: '2px 5px', borderRadius: 6,
                        border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)',
                      }}
                    >
                      {CASE_PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    条
                  </label>
                  <span style={{ flex: 1 }} />
                  <button
                    onClick={() => setCasePage((p) => Math.max(1, p - 1))}
                    disabled={casePage <= 1}
                    style={{
                      fontSize: 11, padding: '2px 9px', borderRadius: 6, border: '1px solid var(--border)',
                      background: 'var(--background-secondary)', color: 'var(--foreground)',
                      cursor: casePage <= 1 ? 'default' : 'pointer', opacity: casePage <= 1 ? 0.5 : 1,
                    }}
                  >
                    上一页
                  </button>
                  <span>{casePage} / {totalPages}</span>
                  <button
                    onClick={() => setCasePage((p) => Math.min(totalPages, p + 1))}
                    disabled={casePage >= totalPages}
                    style={{
                      fontSize: 11, padding: '2px 9px', borderRadius: 6, border: '1px solid var(--border)',
                      background: 'var(--background-secondary)', color: 'var(--foreground)',
                      cursor: casePage >= totalPages ? 'default' : 'pointer', opacity: casePage >= totalPages ? 0.5 : 1,
                    }}
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>

            {/* 实验级评论（针对单个 case / 单个评估器的意见留在各自详情页） */}
            {user && (
              <div style={{ ...CARD, padding: '14px 16px', marginTop: 14 }}>
                <EvalComments
                  experimentId={id}
                  user={user}
                  comments={filterComments(comments, {})}
                  onChanged={loadComments}
                  title="本次评测的评论"
                  placeholder="对这次评测整体结果的意见或建议…"
                />
              </div>
            )}

            {/* 条件挂载：每次打开都是新实例，勾选/标注状态自动重置 */}
            {user && addCasesOpen && (
              <AddExperimentCasesDialog
                onClose={() => setAddCasesOpen(false)}
                onAdded={(msg) => { setNotice(msg); load(true); }}
                experimentId={id}
                agentName={detail.agentName}
                user={user}
                needsReference={needsReference}
              />
            )}
          </>
        )}
      </PageContainer>
    </>
  );
}

export default function ExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ExperimentDetail id={id} />;
}
