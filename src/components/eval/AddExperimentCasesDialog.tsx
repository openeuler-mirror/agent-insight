'use client';

// 往已建实验追加 case 的弹窗（实验详情页入口）。
//
// 与建实验向导第 ②③ 步同源但更紧凑：同一个 /api/experiments/traces 分页列 trace，
// 勾选后可就地标注参考答案，提交打 POST /api/experiments/[id]/cases。
// 不重做第 ④ 步评估器门控——追加的 case 走实验既定的评估器，所以这里把"缺参考答案会
// 让依赖参考数据的评估器不记分"作为前置提示直接摆出来。
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

import { apiFetch } from '@/lib/client/api';

interface TraceItem {
  id: string;
  taskId: string | null;
  query: string | null;
  finalResult: string | null;
  timestamp: string;
  ok: boolean;
}

interface PickedCase {
  executionId: string;
  taskId: string | null;
  input: string;
  actualOutput: string;
  referenceOutput: string | null;
}

const PAGE_SIZE = 8;

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 220,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
};
const MODAL: React.CSSProperties = {
  width: 880, maxWidth: '94vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
  background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 14,
  boxShadow: '0 24px 80px rgba(0,0,0,.35)', overflow: 'hidden',
};
const TH: React.CSSProperties = {
  textAlign: 'left', fontSize: 10.5, fontWeight: 600, color: 'var(--foreground-muted)',
  padding: '8px 10px', borderBottom: '1px solid var(--border)',
  background: 'var(--background-secondary)', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: 'var(--foreground-secondary)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
};
const BTN: React.CSSProperties = {
  fontSize: 12, padding: '5px 14px', borderRadius: 7, fontWeight: 600,
  border: '1px solid var(--border)', background: 'var(--card-bg)',
  color: 'var(--foreground)', cursor: 'pointer', whiteSpace: 'nowrap',
};
const BTN_PRIMARY: React.CSSProperties = {
  ...BTN, background: 'var(--accent)', color: '#fff', borderColor: 'transparent',
};

function truncate(text: string | null | undefined, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 由父组件**条件挂载**（`{open && <AddExperimentCasesDialog …/>}`）而不是靠 open 属性内部
 * 早退——每次打开都是全新实例，勾选/标注/分页状态天然重置，不需要在 effect 里同步 setState。
 */
export function AddExperimentCasesDialog({
  onClose,
  onAdded,
  experimentId,
  agentName,
  user,
  needsReference,
}: {
  onClose: () => void;
  onAdded: (msg: string) => void;
  experimentId: string;
  agentName: string;
  user: string;
  /** 实验里是否含依赖参考数据的评估器——决定要不要提示补标注 */
  needsReference: boolean;
}) {
  const [traces, setTraces] = useState<TraceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Map<string, PickedCase>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (p: number) => {
    if (!user || !agentName) return;
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/experiments/traces?user=${encodeURIComponent(user)}&agent=${encodeURIComponent(agentName)}&page=${p}&pageSize=${PAGE_SIZE}`,
      );
      const data = await res.json();
      setTraces(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
      setPage(p);
    } catch {
      setTraces([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [user, agentName]);

  // 挂载即拉第 1 页（组件是每次打开新建的，列表永远是新的）
  useEffect(() => { load(1); }, [load]);

  const toggle = (t: TraceItem) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) next.delete(t.id);
      else next.set(t.id, {
        executionId: t.id,
        taskId: t.taskId,
        input: t.query || '',
        actualOutput: t.finalResult || '',
        referenceOutput: null,
      });
      return next;
    });
  };

  const setReference = (executionId: string, value: string) => {
    setPicked((prev) => {
      const next = new Map(prev);
      const c = next.get(executionId);
      if (c) next.set(executionId, { ...c, referenceOutput: value.trim() ? value : null });
      return next;
    });
  };

  const pickedList = useMemo(() => Array.from(picked.values()), [picked]);
  const unannotated = pickedList.filter((c) => !c.referenceOutput).length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const submit = useCallback(async () => {
    if (!pickedList.length || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch(`/api/experiments/${encodeURIComponent(experimentId)}/cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, cases: pickedList }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '新增 case 失败'));
      const parts = [`新增 ${data.added} 条 case`];
      if (data.reused > 0) parts.push(`${data.reused} 条已在本实验中（复用，未重复建）`);
      if (data.evaluating) parts.push('评测已在后台执行');
      onAdded(`${parts.join('，')}。`);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '新增 case 失败');
    } finally {
      setSubmitting(false);
    }
  }, [pickedList, submitting, experimentId, user, onAdded, onClose]);

  return (
    <div style={OVERLAY} onClick={onClose}>
      <div style={MODAL} onClick={(e) => e.stopPropagation()}>
        {/* 头 */}
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>新增 Case</span>
          <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
            Agent「{agentName || '—'}」的 trace · 共 {total} 条
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{
            ...BTN, padding: '3px 9px', fontSize: 14, lineHeight: 1, border: 'none',
            background: 'none', color: 'var(--foreground-muted)',
          }}>✕</button>
        </div>

        {/* 说明：追加的 case 走实验既定评估器，不重做门控 */}
        <div style={{
          padding: '9px 18px', borderBottom: '1px solid var(--border)',
          fontSize: 11.5, lineHeight: 1.65, color: 'var(--foreground-secondary)',
          background: 'var(--background-secondary)',
        }}>
          新增的 case 按<b>本实验已配置的评估器</b>评测，提交后立即在后台执行。
          {needsReference && (
            <>
              {' '}本实验含<b>依赖参考数据</b>的评估器——未标注参考答案的 case，该评估器会判为不记分，
              请在下方勾选后展开补标注。
            </>
          )}
        </div>

        {/* trace 列表 */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!agentName ? (
            <div style={{ padding: 28, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>
              本实验未绑定 Agent，无法按 Agent 列出 trace
            </div>
          ) : loading ? (
            <div style={{ padding: 28, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>加载中…</div>
          ) : traces.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', fontSize: 12, color: 'var(--foreground-muted)' }}>
              该 Agent 暂无可选 trace
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 38 }} />
                  <th style={TH}>任务输入</th>
                  <th style={{ ...TH, width: 240 }}>实际输出</th>
                  <th style={{ ...TH, width: 140 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t) => {
                  const sel = picked.get(t.id);
                  const open = expanded === t.id;
                  return (
                    <Fragment key={t.id}>
                      <tr
                        onClick={() => toggle(t)}
                        style={{ cursor: 'pointer', background: sel ? 'var(--primary-subtle)' : undefined }}
                      >
                        <td style={{ ...TD, textAlign: 'center' }}>
                          <input type="checkbox" checked={!!sel} readOnly style={{ pointerEvents: 'none' }} />
                        </td>
                        <td style={{ ...TD, color: 'var(--foreground)' }}>{truncate(t.query, 90)}</td>
                        <td style={TD}>{truncate(t.finalResult, 60)}</td>
                        <td style={{ ...TD, whiteSpace: 'nowrap', fontSize: 11 }}>
                          {new Date(t.timestamp).toLocaleString('zh-CN', { hour12: false })}
                        </td>
                      </tr>
                      {sel && (
                        <tr>
                          <td style={{ ...TD, borderBottom: '1px solid var(--border)' }} />
                          <td colSpan={3} style={{ ...TD, borderBottom: '1px solid var(--border)' }}>
                            {open ? (
                              <>
                                <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 5 }}>
                                  参考答案（可选）
                                </div>
                                <textarea
                                  autoFocus
                                  value={sel.referenceOutput ?? ''}
                                  onChange={(e) => setReference(t.id, e.target.value)}
                                  placeholder="这条 case 的预期结果——依赖参考数据的评估器据此打分"
                                  style={{
                                    width: '100%', minHeight: 64, padding: '7px 9px', fontSize: 12,
                                    lineHeight: 1.6, borderRadius: 7, border: '1px solid var(--input-border)',
                                    background: 'var(--input-bg)', color: 'var(--foreground)',
                                    outline: 'none', resize: 'vertical', fontFamily: 'inherit',
                                    boxSizing: 'border-box',
                                  }}
                                />
                                <button
                                  onClick={() => setExpanded(null)}
                                  style={{ ...BTN, marginTop: 6, padding: '3px 10px', fontSize: 11 }}
                                >
                                  收起
                                </button>
                              </>
                            ) : (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 11.5, color: sel.referenceOutput ? 'var(--foreground)' : 'var(--foreground-muted)' }}>
                                  参考答案：{sel.referenceOutput ? truncate(sel.referenceOutput, 70) : '未标注'}
                                </span>
                                <button
                                  onClick={() => setExpanded(t.id)}
                                  style={{ ...BTN, padding: '3px 10px', fontSize: 11 }}
                                >
                                  {sel.referenceOutput ? '修改' : '标注'}
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 底：分页 + 提交 */}
        <div style={{
          padding: '11px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <button onClick={() => load(Math.max(1, page - 1))} disabled={page <= 1 || loading} style={{
            ...BTN, padding: '3px 10px', fontSize: 11, opacity: page <= 1 ? 0.5 : 1,
          }}>上一页</button>
          <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{page} / {totalPages}</span>
          <button onClick={() => load(Math.min(totalPages, page + 1))} disabled={page >= totalPages || loading} style={{
            ...BTN, padding: '3px 10px', fontSize: 11, opacity: page >= totalPages ? 0.5 : 1,
          }}>下一页</button>

          <span style={{ flex: 1 }} />

          {error && <span style={{ fontSize: 11.5, color: 'var(--error)' }}>{error}</span>}
          <span style={{ fontSize: 11.5, color: 'var(--foreground-muted)' }}>
            已选 {pickedList.length} 条
            {needsReference && unannotated > 0 && ` · ${unannotated} 条未标注参考答案`}
          </span>
          <button onClick={onClose} style={BTN}>取消</button>
          <button
            onClick={submit}
            disabled={!pickedList.length || submitting}
            style={{
              ...BTN_PRIMARY,
              opacity: !pickedList.length || submitting ? 0.5 : 1,
              cursor: !pickedList.length || submitting ? 'default' : 'pointer',
            }}
          >
            {submitting ? '提交中…' : `新增并评测 ${pickedList.length || ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
