'use client';

// Trace 评测详情：任务输入/参考答案/实际输出三框 → 「结果评测」「轨迹评测」两类目 panel
// （类目均分 · N/M 项计入）→ 每个评估器一张全宽卡。
//
// 卡片以**结论**为主：卡头 = 结论 chip（达成/部分达成/未达成）+ 一句话结论 + 得分（次要）；
// 评分点表、证据、失败原因全部收在展开区里——用户先看懂"行不行"，需要核验时才下钻明细。
// 结论来自评估器上报的 verdict/summary（契约见 eval-output.ts），缺 verdict 时按分数派生，
// 缺 summary 时回退到证据首段（存量数据的结论一直被塞在 evidence 里）。
//
// 得分支持人工修正：分层写 humanScore，机器分只读留存，全部均分按生效分重算。
import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';

import { EvalComments, filterComments, type EvalCommentRow } from '@/components/eval/EvalComments';
import { EvidenceBlock } from '@/components/eval/EvidenceBlock';
import { useEvaluatorLookup } from '@/components/eval/useEvaluatorLookup';
import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { categorySummary, effectiveScore, groupByCategory } from '@/lib/engine/experiment/detail-agg';
import { deriveVerdict, displaySummary, isEvidenceRedundant, VERDICT_LABELS, type EvalVerdict } from '@/lib/evaluators/eval-output';
import type { EvaluatorCategory } from '@/lib/evaluators/registry';

interface ResultRow {
  id: string;
  caseId: string;
  evaluatorId: string;
  status: string;
  verdict: EvalVerdict | null;
  summary: string | null;
  score: number | null;
  points: unknown;
  evidence: unknown;
  humanScore: number | null;
  humanReason: string | null;
  humanBy: string | null;
  humanAt: string | null;
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

/** 解析单个评分点；非法（无 label）返回 null。 */
function parseOnePoint(p: unknown): PointRow | null {
  if (!p || typeof p !== 'object') return null;
  const r = p as Record<string, unknown>;
  if (typeof r.label !== 'string' || !r.label.trim()) return null;
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
  return row;
}

/** 宽容解析结果行的 points（脏数据逐条丢弃）。归因字段全可选。 */
function parsePoints(raw: unknown): PointRow[] {
  if (!Array.isArray(raw)) return [];
  const out: PointRow[] = [];
  for (const p of raw) {
    const row = parseOnePoint(p);
    if (row) out.push(row);
  }
  return out;
}

/** 折叠集合的增删：有则去、无则加。 */
function toggled(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** 未达标评分点数：状态为部分/未覆盖，或有分且低于 60。折叠标题上直接标出来，免得要展开才知道有没有问题。 */
function unmetCount(points: PointRow[]): number {
  return points.filter((p) =>
    p.status === 'partial' || p.status === 'missing' || (typeof p.score === 'number' && p.score < 60),
  ).length;
}

const STATUS_CHIP: Record<'covered' | 'partial' | 'missing', { label: string; bg: string; fg: string }> = {
  covered: { label: '已覆盖', bg: 'var(--tag-green-bg, var(--success-subtle))', fg: 'var(--tag-green-fg, var(--success))' },
  partial: { label: '部分覆盖', bg: 'var(--tag-amber-bg, var(--warning-subtle))', fg: 'var(--tag-amber-fg, var(--warning))' },
  missing: { label: '未覆盖', bg: 'var(--background-secondary)', fg: 'var(--foreground-muted)' },
};

/** 结论 chip 配色（文案统一取 VERDICT_LABELS）。 */
const VERDICT_CHIP: Record<EvalVerdict, { bg: string; fg: string }> = {
  pass: { bg: 'var(--tag-green-bg, var(--success-subtle))', fg: 'var(--tag-green-fg, var(--success))' },
  warn: { bg: 'var(--tag-amber-bg, var(--warning-subtle))', fg: 'var(--tag-amber-fg, var(--warning))' },
  fail: { bg: 'var(--tag-red-bg, var(--error-subtle))', fg: 'var(--tag-red-fg, var(--error))' },
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

/** 评分点的「状态 / 可归因 skill」标签组（评分点与子项复用）。 */
function PointBadges({ point }: { point: PointRow }) {
  if (!point.status && !point.skillAttributable) return null;
  return (
    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {point.status && (
        <span style={{
          fontSize: 10, padding: '1px 7px', borderRadius: 6, fontWeight: 500,
          background: STATUS_CHIP[point.status].bg, color: STATUS_CHIP[point.status].fg,
        }}>{STATUS_CHIP[point.status].label}</span>
      )}
      {point.skillAttributable && (
        <span style={{
          fontSize: 10, padding: '1px 7px', borderRadius: 6, fontWeight: 500,
          background: 'var(--primary-subtle)', color: 'var(--primary)',
        }}>可归因 skill</span>
      )}
    </div>
  );
}

/** 评分点「证据」列内容：证据块 + 建议 + 相关步骤锚点（评分点与子项复用）。 */
function PointEvidence({ point, taskId }: { point: PointRow; taskId: string | null }) {
  return (
    <>
      {point.evidence ? <EvidenceBlock evidence={point.evidence} /> : null}
      {point.suggestion && (
        <div style={{ marginTop: point.evidence ? 6 : 0, fontSize: 11, color: 'var(--primary)' }}>
          ↗ 建议：{point.suggestion}
        </div>
      )}
      {point.anchors && point.anchors.length > 0 && (
        <div style={{ marginTop: 5, fontSize: 10.5, color: 'var(--foreground-muted)' }}>
          相关步骤：{point.anchors.map((a) => (
            <a
              key={a}
              href={taskId ? `/trace?taskId=${encodeURIComponent(taskId)}` : undefined}
              style={{
                fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5,
                background: 'var(--background-secondary)', border: '1px solid var(--border)',
                borderRadius: 4, padding: '0 5px', marginRight: 5,
                color: 'var(--foreground-secondary)', textDecoration: 'none',
                cursor: taskId ? 'pointer' : 'default',
              }}
            >{a}</a>
          ))}
        </div>
      )}
    </>
  );
}

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

/** 结论 chip。verdict 为空时按分数派生（deriveVerdict），都取不到则不渲染。 */
function VerdictChip({ verdict, score }: { verdict: EvalVerdict | null; score: number | null }) {
  const v = verdict ?? deriveVerdict(score);
  if (!v) return null;
  return (
    <span style={{
      fontSize: 11, padding: '2px 9px', borderRadius: 8, fontWeight: 600,
      background: VERDICT_CHIP[v].bg, color: VERDICT_CHIP[v].fg, whiteSpace: 'nowrap',
    }}>
      {VERDICT_LABELS[v]}
    </span>
  );
}

/**
 * 人工修正得分：分层写 humanScore，机器分留在 score 里只读展示。
 * 改分必须填理由——没有理由的修正日后无法复盘，也没法拿来校准评估器。
 */
function ScoreAdjuster({
  row, experimentId, user, onDone,
}: {
  row: ResultRow;
  experimentId: string;
  user: string;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [score, setScore] = useState(String(row.humanScore ?? row.score ?? ''));
  const [reason, setReason] = useState(row.humanReason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = useCallback(async (clear = false) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(experimentId)}/results/${encodeURIComponent(row.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            clear
              ? { user, humanScore: null }
              : { user, humanScore: Number(score), humanReason: reason },
          ),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '修正得分失败'));
      setEditing(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '修正得分失败');
    } finally {
      setBusy(false);
    }
  }, [busy, experimentId, row.id, user, score, reason, onDone]);

  if (!editing) {
    return (
      <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
        <button
          onClick={() => { setEditing(true); setError(''); }}
          style={{
            fontSize: 11, padding: '3px 11px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--background-secondary)',
            color: 'var(--foreground)', cursor: 'pointer',
          }}
        >
          {typeof row.humanScore === 'number' ? '↻ 调整人工修正' : '✎ 修正得分'}
        </button>
        {typeof row.humanScore === 'number' && (
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
            由 {row.humanBy || '—'} 修正
            {row.humanAt && ` · ${new Date(row.humanAt).toLocaleString('zh-CN', { hour12: false })}`}
            {row.humanReason && ` · ${row.humanReason}`}
          </span>
        )}
        {error && <span style={{ fontSize: 11, color: 'var(--error)' }}>{error}</span>}
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 9, padding: '9px 11px', borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--background-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 7 }}>
        <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
          机器分 <b style={{ color: 'var(--foreground)' }}>{typeof row.score === 'number' ? row.score : '—'}</b> →
        </span>
        <input
          type="number"
          min={0}
          max={100}
          value={score}
          onChange={(e) => setScore(e.target.value)}
          style={{
            width: 74, height: 28, padding: '0 8px', fontSize: 12, borderRadius: 6,
            border: '1px solid var(--input-border)', background: 'var(--input-bg)',
            color: 'var(--foreground)', outline: 'none',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>人工分（0-100）</span>
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="修正理由（必填）——为什么机器这个分不合理"
        style={{
          width: '100%', height: 30, padding: '0 9px', fontSize: 12, borderRadius: 6,
          border: '1px solid var(--input-border)', background: 'var(--input-bg)',
          color: 'var(--foreground)', outline: 'none', boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button
          onClick={() => save(false)}
          disabled={busy || !score.trim() || !reason.trim()}
          style={{
            fontSize: 11.5, padding: '4px 13px', borderRadius: 6, fontWeight: 600,
            border: '1px solid transparent', background: 'var(--accent)', color: '#fff',
            cursor: busy || !score.trim() || !reason.trim() ? 'default' : 'pointer',
            opacity: busy || !score.trim() || !reason.trim() ? 0.5 : 1,
          }}
        >
          {busy ? '保存中…' : '保存修正'}
        </button>
        <button
          onClick={() => { setEditing(false); setError(''); }}
          style={{
            fontSize: 11.5, padding: '4px 11px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--card-bg)',
            color: 'var(--foreground)', cursor: 'pointer',
          }}
        >
          取消
        </button>
        {typeof row.humanScore === 'number' && (
          <button
            onClick={() => save(true)}
            disabled={busy}
            style={{
              fontSize: 11.5, padding: '4px 11px', borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--card-bg)',
              color: 'var(--foreground-muted)', cursor: busy ? 'default' : 'pointer',
            }}
          >
            撤销修正
          </button>
        )}
        <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>
          修正后全部均分按人工分重算；重评会清除此修正
        </span>
        {error && <span style={{ fontSize: 11, color: 'var(--error)' }}>{error}</span>}
      </div>
    </div>
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
  // 两级折叠：卡片默认折叠只露卡头（结论 chip + 一句话结论 + 得分）；展开后是完整判断
  // 依据 + 人工修正 + 评论，**评分点明细再单独折一层**——它是最长最细的部分，展开卡片
  // 就糊一屏表格的话，等于没做"先看结论"。
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [expandedPoints, setExpandedPoints] = useState<Set<string>>(new Set());
  const toggleCard = useCallback((id: string) => {
    setExpandedCards((prev) => toggled(prev, id));
  }, []);
  const togglePoints = useCallback((id: string) => {
    setExpandedPoints((prev) => toggled(prev, id));
  }, []);

  const [comments, setComments] = useState<EvalCommentRow[]>([]);

  const loadComments = useCallback(async () => {
    if (!user) return;
    try {
      // 一次取回本实验全部评论，前端按 case/结果行分组——否则每个结果行各发一次请求
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}/comments?user=${encodeURIComponent(user)}&scope=all`,
      );
      const data = await res.json();
      setComments(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setComments([]);
    }
  }, [user, id]);

  const load = useCallback(async (silent = false) => {
    if (!user) return;
    if (!silent) setLoading(true);
    try {
      // 带 caseId：让详情 API 精确返回这一条 case（不受 case 列表分页影响，
      // 否则该 case 不在第 1 页时这里 find 不到 → 详情空白）。
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(id)}?user=${encodeURIComponent(user)}&caseId=${encodeURIComponent(caseId)}`,
      );
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
  }, [user, id, caseId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadComments(); }, [loadComments]);

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

            {/* 任务输入 / 参考答案 / 实际输出 三框（等高：grid 行拉伸 + 内框 flex 填满） */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14, alignItems: 'stretch' }}>
              {([
                { label: '任务输入', value: caseRow.input, missing: '' },
                { label: '参考答案', value: caseRow.referenceOutput || '', missing: '未标注参考答案' },
                { label: '实际输出', value: caseRow.actualOutput, missing: '' },
              ] as const).map((box) => (
                <div key={box.label} style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 5 }}>
                    {box.label}
                  </div>
                  <div style={{
                    ...CARD, flex: 1, padding: '9px 11px', fontSize: 12, lineHeight: 1.6, minHeight: 58,
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
                      {summary.adjusted > 0 && ` · 含 ${summary.adjusted} 项人工修正`}
                    </span>
                  </div>
                  <div style={{ padding: 12, display: 'grid', gap: 10 }}>
                    {rows.map((r) => {
                      const tags = lookup.tagsOf(r.evaluatorId);
                      const failed = r.status === 'failed';
                      const pendingLike = r.status === 'pending' || r.status === 'running';
                      const points = parsePoints(r.points);
                      const open = expandedCards.has(r.id);
                      const adjusted = typeof r.humanScore === 'number';
                      const shownScore = effectiveScore(r);
                      const summary = displaySummary(r.summary, r.evidence);
                      const rowComments = filterComments(comments, { resultId: r.id });
                      // 卡体永远可展开：不止评分点/证据，还有人工修正与评论
                      return (
                        <div key={r.id} style={{
                          border: '1px solid var(--border)', borderRadius: 9,
                          padding: '11px 13px', opacity: failed ? 0.85 : 1,
                        }}>
                          {/* 卡头第一行：折叠箭头 + 评估器名 + 标签 + 结论 chip + 得分（次要） */}
                          <div
                            onClick={() => toggleCard(r.id)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
                              cursor: 'pointer', userSelect: 'none',
                            }}
                          >
                            <span style={{
                              fontSize: 12, color: 'var(--foreground-muted)', lineHeight: 1,
                              display: 'inline-block', transition: 'transform .15s',
                              transform: open ? 'rotate(90deg)' : 'none',
                            }}>›</span>
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
                              <>
                                <VerdictChip verdict={r.verdict} score={shownScore} />
                                <span style={{
                                  fontSize: 15, fontWeight: 700,
                                  color: adjusted ? 'var(--warning)' : 'var(--accent)',
                                }}>
                                  {typeof shownScore === 'number' ? shownScore : '—'}
                                </span>
                                {adjusted && (
                                  <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>
                                    人工修正 · 原 {typeof r.score === 'number' ? r.score : '—'}
                                  </span>
                                )}
                              </>
                            )}
                          </div>

                          {/* 卡头第二行：一句话结论——这是用户要一眼看到的东西，永远展示 */}
                          {!failed && !pendingLike && summary && (
                            <div style={{
                              marginTop: 6, fontSize: 12.5, lineHeight: 1.7,
                              color: 'var(--foreground)', wordBreak: 'break-word',
                            }}>
                              {summary}
                            </div>
                          )}
                          {failed && (
                            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--foreground-secondary)' }}>
                              {r.errorMessage || '评估未产出结果——不记 0 分、不入类目均分。'}
                            </div>
                          )}

                          {/* 卡体（默认折叠）：评分点表 / 卡级证据 / 重评 / 人工修正 / 评论 */}
                          {open && (
                            <>
                              {failed && (
                                <div style={{ marginTop: 9 }}>
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
                              )}

                              {/* 完整判断依据：与卡头那句结论逐字相同就不重复渲染。
                                  （此前这段在有评分点时被 else 分支吃掉，永远显示不出来。） */}
                              {r.evidence && !isEvidenceRedundant(r.summary, r.evidence) ? (
                                <div style={{ marginTop: 9 }}>
                                  <EvidenceBlock evidence={r.evidence} />
                                </div>
                              ) : null}

                              {/* 评分点明细：二级折叠，默认收起，标题上直接标出有几项没达标 */}
                              {points.length > 0 && (
                                <div style={{ marginTop: 9 }}>
                                  <button
                                    onClick={() => togglePoints(r.id)}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                                      padding: '5px 0', border: 'none', background: 'none',
                                      color: 'var(--foreground-secondary)', fontSize: 11.5,
                                      cursor: 'pointer', textAlign: 'left',
                                    }}
                                  >
                                    <span style={{
                                      display: 'inline-block', transition: 'transform .15s', lineHeight: 1,
                                      transform: expandedPoints.has(r.id) ? 'rotate(90deg)' : 'none',
                                    }}>›</span>
                                    评分点明细 · {points.length} 项
                                    {unmetCount(points) > 0 && (
                                      <span style={{ color: 'var(--warning)' }}>
                                        （{unmetCount(points)} 项未达标）
                                      </span>
                                    )}
                                  </button>
                                  {expandedPoints.has(r.id) && (
                                    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', marginTop: 4 }}>
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
                                              <PointBadges point={p} />
                                            </td>
                                            <td style={{ ...TD, verticalAlign: 'top', fontWeight: 700 }}>{typeof p.score === 'number' ? p.score : '—'}</td>
                                            <td style={{ ...TD, verticalAlign: 'top', overflow: 'hidden' }}>
                                              <PointEvidence point={p} taskId={caseRow.taskId} />
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              )}

                              {/* 人工修正得分（仅已完成的行——失败/待执行没有可对照的机器判断） */}
                              {r.status === 'done' && user && (
                                <ScoreAdjuster
                                  row={r}
                                  experimentId={id}
                                  user={user}
                                  onDone={() => load(true)}
                                />
                              )}

                              {/* 该评估器结果的评论 */}
                              {user && (
                                <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                                  <EvalComments
                                    experimentId={id}
                                    user={user}
                                    resultId={r.id}
                                    comments={rowComments}
                                    onChanged={loadComments}
                                    compact
                                    title="对这项评估的评论"
                                    placeholder="对这个评估器的判断有什么意见或建议…"
                                  />
                                </div>
                              )}
                            </>
                          )}
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

            {/* 本条 case 的整体评论（对单个评估器的意见留在各自卡片里） */}
            {user && (
              <div style={{ ...CARD, padding: '14px 16px', marginTop: 14 }}>
                <EvalComments
                  experimentId={id}
                  user={user}
                  caseId={caseId}
                  comments={filterComments(comments, { caseId })}
                  onChanged={loadComments}
                  title="本条 Case 的评论"
                  placeholder="对这条 case 的评测结果有什么意见或建议…"
                />
              </div>
            )}
          </>
        )}
      </PageContainer>
    </>
  );
}
