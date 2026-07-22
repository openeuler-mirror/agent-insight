'use client';

// 新建实验 —— 四步向导（单组形态）：
// ① 实验设计 → ② 关联 Trace（圈选 case）→ ③ 预期答案（可选标注）→ ④ 评估器（硬门控）
// 对照仓库根目录「评测实验-高保真.html」的单组流程。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AppTopBar } from '@/components/shell/AppTopBar';
import { PageContainer } from '@/components/shell/PageContainer';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { deriveEvaluatorTags, gateEvaluator, getEvaluatorMeta } from '@/lib/evaluators/registry';

interface AgentOption { name: string; traces: number }

interface TraceItem {
  id: string;
  taskId: string | null;
  query: string | null;
  finalResult: string | null;
  latency: number | null;
  tokens: number | null;
  timestamp: string;
  ok: boolean;
}

interface SelectedCase {
  executionId: string;
  taskId: string | null;
  input: string;
  actualOutput: string;
  referenceOutput: string | null;
}

const STEPS = ['实验设计', '关联 Trace', '预期答案', '评估器'];
const PAGE_SIZE = 10;

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '7px 10px', fontSize: 11, fontWeight: 600,
  color: 'var(--foreground-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '8px 10px', fontSize: 12, color: 'var(--foreground)',
  borderBottom: '1px solid var(--border)', verticalAlign: 'middle',
};
const CARD: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--card-border)',
  borderRadius: 10, padding: 16,
};
const LABEL: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500,
  color: 'var(--foreground-secondary)', marginBottom: 6,
};
const INPUT: React.CSSProperties = {
  width: '100%', padding: '7px 10px', fontSize: 12.5, borderRadius: 7,
  border: '1px solid var(--border)', background: 'var(--background)',
  color: 'var(--foreground)', outline: 'none',
};

function truncate(text: string | null | undefined, max: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '—';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function Stepper({ step, maxVisited, onJump }: { step: number; maxVisited: number; onJump: (s: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      {STEPS.map((label, i) => {
        const idx = i + 1;
        const active = idx === step;
        const reachable = idx <= maxVisited;
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => reachable && onJump(idx)}
              disabled={!reachable}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '5px 12px', borderRadius: 16, fontSize: 12,
                border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                background: active ? 'var(--primary-subtle)' : 'var(--card-bg)',
                color: active ? 'var(--primary)' : reachable ? 'var(--foreground-secondary)' : 'var(--foreground-muted)',
                fontWeight: active ? 600 : 400,
                cursor: reachable ? 'pointer' : 'default',
              }}
            >
              <span style={{
                width: 16, height: 16, borderRadius: '50%', fontSize: 10.5,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: active ? 'var(--primary)' : 'var(--background-secondary)',
                color: active ? '#fff' : 'var(--foreground-muted)', fontWeight: 600,
              }}>
                {idx}
              </span>
              {label}
            </button>
            {idx < STEPS.length && (
              <span style={{ width: 18, height: 1, background: 'var(--border)' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function NewExperimentPage() {
  const router = useRouter();
  const { user } = useAuth();

  const [step, setStep] = useState(1);
  const [maxVisited, setMaxVisited] = useState(1);

  // ① 实验设计
  const [name, setName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);

  // ② 关联 Trace
  const [traces, setTraces] = useState<TraceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectedCase>>(new Map());

  // ③ 预期答案
  const [expandedCase, setExpandedCase] = useState<string | null>(null);
  const [draftRef, setDraftRef] = useState('');

  // ④ 评估器
  const [customEvaluators, setCustomEvaluators] = useState<EvaluatorCard[]>([]);
  const [selectedEvaluators, setSelectedEvaluators] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (!user) return;
    apiFetch(`/api/experiments/agents?user=${encodeURIComponent(user)}`)
      .then((r) => r.json())
      .then((d) => setAgents(Array.isArray(d?.agents) ? d.agents : []))
      .catch(() => setAgents([]));
    apiFetch(`/api/user-evaluators?user=${encodeURIComponent(user)}`)
      .then((r) => r.json())
      .then((d) => setCustomEvaluators(Array.isArray(d) ? d : []))
      .catch(() => setCustomEvaluators([]));
  }, [user]);

  const loadTraces = useCallback(async (p: number) => {
    if (!user || !agentName) return;
    setTracesLoading(true);
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
      setTracesLoading(false);
    }
  }, [user, agentName]);

  useEffect(() => {
    if (step === 2) loadTraces(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const goTo = (s: number) => {
    setStep(s);
    setMaxVisited((m) => Math.max(m, s));
  };

  const toggleTrace = (t: TraceItem) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) {
        next.delete(t.id);
      } else {
        next.set(t.id, {
          executionId: t.id,
          taskId: t.taskId,
          input: t.query || '',
          actualOutput: t.finalResult || '',
          referenceOutput: null,
        });
      }
      return next;
    });
  };

  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);
  const annotated = selectedList.filter((c) => !!c.referenceOutput).length;

  const setReference = (executionId: string, value: string | null) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const c = next.get(executionId);
      if (c) next.set(executionId, { ...c, referenceOutput: value && value.trim() ? value : null });
      return next;
    });
  };

  // ④ 门控输入：每条已选 case 的参考标注情况
  const gateCases = useMemo(
    () => selectedList.map((c) => ({ hasReference: !!c.referenceOutput })),
    [selectedList],
  );

  const allEvaluators = useMemo(
    () => [...presetEvaluators, ...customEvaluators],
    [customEvaluators],
  );

  const toggleEvaluator = (id: string) => {
    setSelectedEvaluators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!user || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await apiFetch('/api/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user,
          name,
          agentName,
          cases: selectedList,
          evaluatorIds: Array.from(selectedEvaluators),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || '创建实验失败'));
      router.push(`/experiments/${data.id}`);
    } catch (e: any) {
      setSubmitError(e?.message || '创建实验失败');
      setSubmitting(false);
    }
  };

  const step1Valid = name.trim() !== '' && agentName !== '';
  const step2Valid = selected.size >= 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const footer = (opts: { nextDisabled?: boolean; nextLabel?: string; onNext?: () => void }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
      <div>
        {step > 1 && (
          <Button size="sm" variant="outline" onClick={() => goTo(step - 1)}>上一步</Button>
        )}
      </div>
      <Button
        size="sm"
        disabled={opts.nextDisabled}
        onClick={opts.onNext ?? (() => goTo(step + 1))}
      >
        {opts.nextLabel ?? '下一步'}
      </Button>
    </div>
  );

  return (
    <>
      <AppTopBar title="新建实验" />
      <PageContainer>
        <Stepper step={step} maxVisited={maxVisited} onJump={goTo} />

        {step === 1 && (
          <div style={{ ...CARD, maxWidth: 560 }}>
            <div style={{ marginBottom: 14 }}>
              <label style={LABEL}>实验名称</label>
              <input
                style={INPUT}
                value={name}
                placeholder="如：客服 Agent 回答质量基线"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={LABEL}>待评测 Agent</label>
              <select
                style={{ ...INPUT, cursor: 'pointer' }}
                value={agentName}
                onChange={(e) => {
                  setAgentName(e.target.value);
                  // 换 Agent 意味换 trace 池，已圈选 case 一并作废
                  setSelected(new Map());
                  setPage(1);
                }}
              >
                <option value="">请选择 Agent…</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}（{a.traces} 条 trace）</option>
                ))}
              </select>
            </div>
            <div>
              <label style={LABEL}>实验类型</label>
              <span style={{
                display: 'inline-block', fontSize: 12, padding: '4px 10px', borderRadius: 8,
                background: 'var(--primary-subtle)', color: 'var(--primary)', fontWeight: 500,
              }}>
                无变量 · 单组
              </span>
            </div>
            {footer({ nextDisabled: !step1Valid })}
          </div>
        )}

        {step === 2 && (
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, fontSize: 12 }}>
              <span style={{ color: 'var(--foreground-muted)' }}>Agent：</span>
              <span style={{
                padding: '2px 8px', borderRadius: 8, background: 'var(--background-secondary)',
                color: 'var(--foreground)', fontWeight: 500,
              }}>
                {agentName}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--primary)', fontWeight: 600 }}>
                已选 {selected.size} 条
              </span>
            </div>

            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, width: 34 }} />
                    <th style={TH}>Trace ID</th>
                    <th style={TH}>任务输入</th>
                    <th style={TH}>状态</th>
                    <th style={{ ...TH, textAlign: 'right' }}>耗时</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Token</th>
                    <th style={TH}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {tracesLoading ? (
                    <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', color: 'var(--foreground-muted)' }}>加载中…</td></tr>
                  ) : traces.length === 0 ? (
                    <tr><td colSpan={7} style={{ ...TD, textAlign: 'center', color: 'var(--foreground-muted)' }}>该 Agent 暂无 trace</td></tr>
                  ) : traces.map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => toggleTrace(t)}
                      style={{ cursor: 'pointer', background: selected.has(t.id) ? 'var(--primary-subtle)' : 'transparent' }}
                    >
                      <td style={TD}>
                        <input type="checkbox" readOnly checked={selected.has(t.id)} style={{ cursor: 'pointer' }} />
                      </td>
                      <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'nowrap' }}>
                        {truncate(t.taskId || t.id, 18)}
                      </td>
                      <td style={{ ...TD, maxWidth: 320 }}>{truncate(t.query, 60)}</td>
                      <td style={TD}>
                        <span style={{
                          fontSize: 11, padding: '1px 7px', borderRadius: 8, fontWeight: 500,
                          background: t.ok ? 'var(--tag-green-bg)' : 'var(--tag-red-bg)',
                          color: t.ok ? 'var(--tag-green-fg)' : 'var(--tag-red-fg)',
                        }}>
                          {t.ok ? '成功' : '异常'}
                        </span>
                      </td>
                      <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {t.latency != null ? `${t.latency.toFixed(1)}s` : '—'}
                      </td>
                      <td style={{ ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {t.tokens != null ? t.tokens.toLocaleString() : '—'}
                      </td>
                      <td style={{ ...TD, color: 'var(--foreground-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(t.timestamp).toLocaleString('zh-CN', { hour12: false })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12 }}>
              <Button size="sm" variant="outline" disabled={page <= 1 || tracesLoading} onClick={() => loadTraces(page - 1)}>
                上一页
              </Button>
              <span style={{ color: 'var(--foreground-muted)' }}>{page} / {totalPages}</span>
              <Button size="sm" variant="outline" disabled={page >= totalPages || tracesLoading} onClick={() => loadTraces(page + 1)}>
                下一页
              </Button>
            </div>

            {footer({ nextDisabled: !step2Valid })}
          </div>
        )}

        {step === 3 && (
          <div style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, fontSize: 12 }}>
              <span style={{ color: 'var(--foreground-secondary)' }}>
                预期答案为可选标注——不标注也可直接下一步；依赖参考数据的评估器将按标注情况在第 ④ 步门控。
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                已标注 {annotated}/{selectedList.length}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {selectedList.map((c) => {
                const open = expandedCase === c.executionId;
                return (
                  <div key={c.executionId} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>{truncate(c.input, 70)}</div>
                        <div style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
                          实际输出：{truncate(c.actualOutput, 80)}
                        </div>
                      </div>
                      <span style={{
                        fontSize: 11, padding: '1px 7px', borderRadius: 8, fontWeight: 500, whiteSpace: 'nowrap',
                        background: c.referenceOutput ? 'var(--tag-green-bg)' : 'var(--background-secondary)',
                        color: c.referenceOutput ? 'var(--tag-green-fg)' : 'var(--foreground-muted)',
                      }}>
                        {c.referenceOutput ? '已标注' : '未标注'}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (open) {
                            setExpandedCase(null);
                          } else {
                            setExpandedCase(c.executionId);
                            // 预填：已有参考输出 > 实际输出
                            setDraftRef(c.referenceOutput ?? c.actualOutput);
                          }
                        }}
                      >
                        {open ? '收起' : '标注'}
                      </Button>
                    </div>
                    {open && (
                      <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
                        <label style={{ ...LABEL, marginTop: 10 }}>参考输出（预期答案）</label>
                        <textarea
                          style={{ ...INPUT, minHeight: 96, resize: 'vertical', fontFamily: 'inherit' }}
                          value={draftRef}
                          onChange={(e) => setDraftRef(e.target.value)}
                        />
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                          <Button
                            size="sm"
                            onClick={() => {
                              setReference(c.executionId, draftRef);
                              setExpandedCase(null);
                            }}
                          >
                            保存
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setReference(c.executionId, null);
                              setExpandedCase(null);
                            }}
                          >
                            清除标注
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {footer({})}
          </div>
        )}

        {step === 4 && (
          <div style={CARD}>
            <div style={{ fontSize: 12, color: 'var(--foreground-secondary)', marginBottom: 12 }}>
              为本次实验挑选评估器（可多选）。依赖参考数据的评估器要求所有已选 case 均已标注预期答案。
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
              {allEvaluators.map((card) => {
                const meta = getEvaluatorMeta(card);
                const gate = gateEvaluator(meta, gateCases);
                const checked = selectedEvaluators.has(card.id);
                return (
                  <div
                    key={card.id}
                    title={gate.usable ? undefined : gate.reason}
                    onClick={() => gate.usable && toggleEvaluator(card.id)}
                    style={{
                      border: `1px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
                      borderRadius: 9, padding: '10px 12px',
                      background: checked ? 'var(--primary-subtle)' : 'var(--background)',
                      opacity: gate.usable ? 1 : 0.45,
                      cursor: gate.usable ? 'pointer' : 'not-allowed',
                      transition: 'all 0.12s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <input type="checkbox" readOnly checked={checked} disabled={!gate.usable} />
                      <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {card.name}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--foreground-muted)', marginBottom: 8, minHeight: 28 }}>
                      {truncate(card.description, 64)}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {deriveEvaluatorTags(card).map((tag) => (
                        <span key={tag} style={{
                          fontSize: 10.5, padding: '1px 6px', borderRadius: 7,
                          background: 'var(--background-secondary)', color: 'var(--foreground-secondary)',
                        }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {submitError && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--error)' }}>{submitError}</div>
            )}

            {footer({
              nextDisabled: selectedEvaluators.size < 1 || submitting,
              nextLabel: submitting ? '创建中…' : '开始实验',
              onNext: submit,
            })}
          </div>
        )}
      </PageContainer>
    </>
  );
}
