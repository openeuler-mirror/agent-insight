'use client';

// 评测评论区：实验级 / case 级 / 结果行级共用一个组件，靠 caseId/resultId 圈定范围。
// 评论不参与任何统计口径——纯粹是给这次评测留意见和建议（改分的结构化理由走
// ExperimentEvalResult.humanReason，不在这里）。
import { useCallback, useState } from 'react';

import { apiFetch } from '@/lib/client/api';

export interface EvalCommentRow {
  id: string;
  caseId: string | null;
  resultId: string | null;
  user: string;
  body: string;
  createdAt: string;
}

const BOX: React.CSSProperties = {
  width: '100%', minHeight: 56, padding: '7px 9px', fontSize: 12, lineHeight: 1.6,
  borderRadius: 7, border: '1px solid var(--input-border)', background: 'var(--input-bg)',
  color: 'var(--foreground)', outline: 'none', resize: 'vertical',
  fontFamily: 'inherit', boxSizing: 'border-box',
};
const BTN: React.CSSProperties = {
  fontSize: 11.5, padding: '4px 12px', borderRadius: 6, fontWeight: 600,
  border: '1px solid transparent', background: 'var(--accent)', color: '#fff', cursor: 'pointer',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : '';
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function EvalComments({
  experimentId,
  user,
  caseId = null,
  resultId = null,
  comments,
  onChanged,
  title = '评论',
  placeholder = '对这次评测结果的意见或建议…',
  compact = false,
}: {
  experimentId: string;
  user: string;
  caseId?: string | null;
  resultId?: string | null;
  /** 本范围内的评论（由页面统一拉取后按范围过滤下发，避免每个结果行各发一次请求） */
  comments: EvalCommentRow[];
  onChanged: () => void;
  title?: string;
  placeholder?: string;
  /** 结果行内嵌用：更小的留白与字号 */
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || busy || !user) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, caseId, resultId, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '发表评论失败'));
      setDraft('');
      onChanged();
    } catch (e) {
      setError(errMessage(e, '发表评论失败'));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, user, experimentId, caseId, resultId, onChanged]);

  const remove = useCallback(async (commentId: string) => {
    if (busy || !user) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(
        `/api/experiments/${encodeURIComponent(experimentId)}/comments?user=${encodeURIComponent(user)}&commentId=${encodeURIComponent(commentId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '删除评论失败'));
      onChanged();
    } catch (e) {
      setError(errMessage(e, '删除评论失败'));
    } finally {
      setBusy(false);
    }
  }, [busy, user, experimentId, onChanged]);

  const pad = compact ? 0 : 2;

  return (
    <div style={{ paddingTop: pad }}>
      <div style={{
        fontSize: compact ? 11 : 12, fontWeight: 600,
        color: 'var(--foreground-muted)', marginBottom: 7,
      }}>
        {title}{comments.length > 0 && ` · ${comments.length}`}
      </div>

      {comments.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
          {comments.map((c) => (
            <div key={c.id} style={{
              border: '1px solid var(--border)', borderRadius: 7, padding: '7px 9px',
              background: 'var(--background-secondary)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 600 }}>{c.user}</span>
                <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)' }}>{fmtTime(c.createdAt)}</span>
                <span style={{ flex: 1 }} />
                {c.user === user && (
                  <button
                    onClick={() => remove(c.id)}
                    disabled={busy}
                    style={{
                      fontSize: 10.5, padding: '1px 7px', borderRadius: 5,
                      border: '1px solid var(--border)', background: 'var(--card-bg)',
                      color: 'var(--foreground-muted)', cursor: busy ? 'default' : 'pointer',
                    }}
                  >
                    删除
                  </button>
                )}
              </div>
              <div style={{
                fontSize: 12, lineHeight: 1.65, color: 'var(--foreground)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {c.body}
              </div>
            </div>
          ))}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        style={BOX}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6 }}>
        <button onClick={submit} disabled={busy || !draft.trim()} style={{
          ...BTN, opacity: busy || !draft.trim() ? 0.5 : 1,
          cursor: busy || !draft.trim() ? 'default' : 'pointer',
        }}>
          {busy ? '提交中…' : '发表评论'}
        </button>
        {error && <span style={{ fontSize: 11, color: 'var(--error)' }}>{error}</span>}
      </div>
    </div>
  );
}

/** 按范围过滤评论：实验级 = caseId/resultId 都为空。 */
export function filterComments(
  all: EvalCommentRow[],
  scope: { caseId?: string | null; resultId?: string | null },
): EvalCommentRow[] {
  if (scope.resultId) return all.filter((c) => c.resultId === scope.resultId);
  if (scope.caseId) return all.filter((c) => c.caseId === scope.caseId && !c.resultId);
  return all.filter((c) => !c.caseId && !c.resultId);
}
