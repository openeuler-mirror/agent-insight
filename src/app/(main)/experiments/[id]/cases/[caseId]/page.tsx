'use client';

// Trace 评测详情：任务输入/参考答案/实际输出三框 → 「结果评测」「轨迹评测」两类目 panel
// （类目均分 · N/M 项计入）→ 每个评估器一张全宽卡（评分点表 + 证据折叠 md/json 渲染；
// 失败卡 = 「评估失败」chip + 原因 + 单项重评）。类目归属来自 registry 元数据。
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';

import { EvidenceBlock } from '@/components/eval/EvidenceBlock';
import { useEvaluatorLookup } from '@/components/eval/useEvaluatorLookup';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { categorySummary, groupByCategory } from '@/lib/engine/experiment/detail-agg';
import type { EvaluatorCategory } from '@/lib/evaluators/registry';

interface ResultRow {
  id: string;
  caseId: string;
  evaluatorId: string;
  status: string;
  score: number | null;
  points: unknown;
  evidence: unknown;
  errorMessage: string | null;
}

interface ExperimentDetail {
  id: string;
  name: string;
  status: string;
  cases: Array<{
    id: string;
    taskId: string | null;
    input: string;
    actualOutput: string;
    referenceOutput: string | null;
  }>;
  results: ResultRow[];
}

interface PointRow {
  label: string;
  score?: number;
  evidence?: unknown;
  status?: 'covered' | 'partial' | 'missing';
  skillAttributable?: boolean;
  suggestion?: string;
  anchors?: string[];
}

/** 宽容解析结果行的 points（脏数据逐条丢弃）。归因字段全可选。 */
function parsePoints(raw: unknown): PointRow[] {
  if (!Array.isArray(raw)) return [];
  const out: PointRow[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    if (typeof r.label !== 'string' || !r.label.trim()) continue;
    const row: PointRow = {
      label: r.label,
      score: typeof r.score === 'number' ? r.score : undefined,
      evidence: r.evidence,
    };
    if (r.status === 'covered' || r.status === 'partial' || r.status === 'missing') row.status = r.status;
    if (typeof r.skillAttributable === 'boolean') row.skillAttributable = r.skillAttributable;
    if (typeof r.suggestion === 'string' && r.suggestion.trim()) row.suggestion = r.suggestion.trim();
    if (Array.isArray(r.anchors)) {
      const a = r.anchors.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
      if (a.length) row.anchors = a;
    }
    out.push(row);
  }
  return out;
}

const STATUS_CHIP: Record<'covered' | 'partial' | 'missing', { label: string; bg: string; fg: string }> = {
  covered: { label: '已覆盖', bg: 'var(--tag-green-bg, var(--success-subtle))', fg: 'var(--tag-green-fg, var(--success))' },
  partial: { label: '部分覆盖', bg: 'var(--tag-amber-bg, var(--warning-subtle))', fg: 'var(--tag-amber-fg, var(--warning))' },
  missing: { label: '未覆盖', bg: 'var(--background-secondary)', fg: 'var(--foreground-muted)' },
};

const CARD: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 10,
};
const TH: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
  wordBreak: 'break-word', overflowWrap: 'anywhere',
};

const CATEGORY_LABEL: Record<EvaluatorCategory, string> = {
  res: '结果评测',
  traj: '轨迹评测',
};

function TagChip({ text }: { text: string }) {
  return (
    <span style={{
      fontSize: 10.5, padding: '1px 7px', borderRadius: 8,
      background: 'var(--background-secondary)', color: 'var(--foreground-muted)',
    }}>
      {text}
    </span>
  );
}

export default function TraceEvalDetailPage({ params }: { params: Promise<{ id: string; caseId: string }> }) {
  const { id, caseId } = use(params);
  const { user } = useAuth();
  const lookup = useEvaluatorLookup(user);
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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

  const caseRow = detail?.cases.find((c) => c.id === caseId) ?? null;
  const caseResults = useMemo(
    () => (detail ? detail.results.filter((r) => r.caseId === caseId) : []),
    [detail, caseId],
  );
  const byCategory = useMemo(
    () => groupByCategory(caseResults, lookup.categoryOf),
    [caseResults, lookup],
  );

  const inputSummary = (caseRow?.input || '').replace(/\s+/g, ' ').trim();

  return (
    <>
      <AppTopBar title="Trace 评测详情" />
      <PageContainer>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>加载中…</div>
        ) : !detail || !caseRow ? (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--error)' }}>
            {error || 'case 不存在'}
          </div>
        ) : (
          <>
            {error && (
              <div style={{ ...CARD, padding: 10, marginBottom: 12, fontSize: 12, color: 'var(--error)' }}>{error}</div>
            )}

            {/* 页头 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <Link
                href={`/experiments/${encodeURIComponent(id)}`}
                style={{
                  fontSize: 12, color: 'var(--foreground-secondary)', textDecoration: 'none',
                  padding: '4px 10px', borderRadius: 7, border: '1px solid var(--border)',
                  background: 'var(--background-secondary)',
                }}
              >
                ‹ 返回实验详情
              </Link>
              <span style={{
                fontSize: 13, fontWeight: 600, maxWidth: 520, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {inputSummary.length > 60 ? `${inputSummary.slice(0, 60)}…` : inputSummary || '—'}
              </span>
              <span style={{ flex: 1 }} />
              {caseRow.taskId && (
                <Link
                  href={`/trace?taskId=${encodeURIComponent(caseRow.taskId)}`}
                  style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}
                >
                  前往链路观测 →
                </Link>
              )}
            </div>

            {/* 任务输入 / 参考答案 / 实际输出 三框 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
              {([
                { label: '任务输入', value: caseRow.input, missing: '' },
                { label: '参考答案', value: caseRow.referenceOutput || '', missing: '未标注参考答案' },
                { label: '实际输出', value: caseRow.actualOutput, missing: '' },
              ] as const).map((box) => (
                <div key={box.label}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 5 }}>
                    {box.label}
                  </div>
                  <div style={{
                    ...CARD, padding: '9px 11px', fontSize: 12, lineHeight: 1.6, minHeight: 58,
                    maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    color: box.value ? 'var(--foreground)' : 'var(--foreground-muted)',
                  }}>
                    {box.value || box.missing || '—'}
                  </div>
                </div>
              ))}
            </div>

            {/* 结果评测 / 轨迹评测 两类目 panel */}
            {(['res', 'traj'] as EvaluatorCategory[]).map((cat) => {
              const rows = byCategory[cat];
              if (!rows.length) return null;
              const summary = categorySummary(rows);
              return (
                <div key={cat} style={{ ...CARD, marginBottom: 14 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '11px 16px', borderBottom: '1px solid var(--border)',
                  }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{CATEGORY_LABEL[cat]}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--accent)' }}>
                      {typeof summary.avg === 'number' ? summary.avg : '—'}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>
                      类目均分 · {summary.scored}/{summary.total} 项计入
                    </span>
                  </div>
                  <div style={{ padding: 12, display: 'grid', gap: 10 }}>
                    {rows.map((r) => {
                      const tags = lookup.tagsOf(r.evaluatorId);
                      const failed = r.status === 'failed';
                      const pendingLike = r.status === 'pending' || r.status === 'running';
                      const points = parsePoints(r.points);
                      return (
                        <div key={r.id} style={{
                          border: '1px solid var(--border)', borderRadius: 9,
                          padding: '11px 13px', opacity: failed ? 0.85 : 1,
                        }}>
                          {/* 卡头：评估器名 + 标签 + 得分 / 失败 chip */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{lookup.nameOf(r.evaluatorId)}</span>
                            {tags.map((t) => <TagChip key={t} text={t} />)}
                            <span style={{ flex: 1 }} />
                            {failed ? (
                              <span style={{
                                fontSize: 11, padding: '1px 8px', borderRadius: 8, fontWeight: 500,
                                background: 'var(--tag-amber-bg)', color: 'var(--tag-amber-fg)',
                              }}>
                                评估失败
                              </span>
                            ) : pendingLike ? (
                              <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
                                {r.status === 'running' ? '执行中…' : '待执行'}
                              </span>
                            ) : (
                              <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--accent)' }}>
                                {typeof r.score === 'number' ? r.score : '—'}
                              </span>
                            )}
                          </div>

                          {/* 失败卡：原因 + 单项重评 */}
                          {failed ? (
                            <>
                              <div style={{ marginTop: 7, fontSize: 11.5, color: 'var(--foreground-secondary)' }}>
                                {r.errorMessage || '评估未产出结果——不记 0 分、不入类目均分。'}
                              </div>
                              <div style={{ marginTop: 8 }}>
                                <button
                                  onClick={() => retryResult(r.id)}
                                  disabled={!!retryingId}
                                  style={{
                                    fontSize: 11, padding: '3px 11px', borderRadius: 6,
                                    border: '1px solid var(--border)', background: 'var(--background-secondary)',
                                    color: 'var(--foreground)', cursor: retryingId ? 'default' : 'pointer',
                                    opacity: retryingId && retryingId !== r.id ? 0.5 : 1,
                                  }}
                                >
                                  {retryingId === r.id ? '重评中…' : '↻ 重评'}
                                </button>
                              </div>
                            </>
                          ) : points.length > 0 ? (
                            /* 卡体：评分点表（评分点 / 得分 / 证据） */
                            <div style={{ marginTop: 9 }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                                <thead>
                                  <tr>
                                    <th style={{ ...TH, width: 180 }}>评分点</th>
                                    <th style={{ ...TH, width: 52 }}>得分</th>
                                    <th style={TH}>证据</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {points.map((p, i) => (
                                    <tr key={i}>
                                      <td style={{ ...TD, fontWeight: 600, fontSize: 11.5, verticalAlign: 'top' }}>
                                        {p.label}
                                        {(p.status || p.skillAttributable) && (
                                          <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                            {p.status && (
                                              <span style={{
                                                fontSize: 10, padding: '1px 7px', borderRadius: 6, fontWeight: 500,
                                                background: STATUS_CHIP[p.status].bg, color: STATUS_CHIP[p.status].fg,
                                              }}>{STATUS_CHIP[p.status].label}</span>
                                            )}
                                            {p.skillAttributable && (
                                              <span style={{
                                                fontSize: 10, padding: '1px 7px', borderRadius: 6, fontWeight: 500,
                                                background: 'var(--primary-subtle)', color: 'var(--primary)',
                                              }}>可归因 skill</span>
                                            )}
                                          </div>
                                        )}
                                      </td>
                                      <td style={{ ...TD, verticalAlign: 'top' }}>{typeof p.score === 'number' ? p.score : '—'}</td>
                                      <td style={{ ...TD, verticalAlign: 'top', overflow: 'hidden' }}>
                                        {p.evidence ? <EvidenceBlock evidence={p.evidence} /> : null}
                                        {p.suggestion && (
                                          <div style={{ marginTop: p.evidence ? 6 : 0, fontSize: 11, color: 'var(--primary)' }}>
                                            ↗ 建议：{p.suggestion}
                                          </div>
                                        )}
                                        {p.anchors && p.anchors.length > 0 && (
                                          <div style={{ marginTop: 5, fontSize: 10.5, color: 'var(--foreground-muted)' }}>
                                            相关步骤：{p.anchors.map((a) => (
                                              <a
                                                key={a}
                                                href={caseRow.taskId ? `/trace?taskId=${encodeURIComponent(caseRow.taskId)}` : undefined}
                                                style={{
                                                  fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5,
                                                  background: 'var(--background-secondary)', border: '1px solid var(--border)',
                                                  borderRadius: 4, padding: '0 5px', marginRight: 5,
                                                  color: 'var(--foreground-secondary)', textDecoration: 'none',
                                                  cursor: caseRow.taskId ? 'pointer' : 'default',
                                                }}
                                              >{a}</a>
                                            ))}
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : r.evidence ? (
                            /* 无评分点、只有卡级证据：整行渲染 */
                            <div style={{ marginTop: 9 }}>
                              <EvidenceBlock evidence={r.evidence} />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {caseResults.length === 0 && (
              <div style={{ ...CARD, padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>
                该 case 暂无评测结果——实验尚未执行
              </div>
            )}
          </>
        )}
      </PageContainer>
    </>
  );
}
