'use client';

// 模型单价管理（放在「模型注册」页）。
// - 单价按模型名(前缀)独立配置，覆盖链路里出现的任意模型（不限于已注册的评测 Provider）。
// - 全局配置；仅管理员(env AGENT_INSIGHT_ADMIN_USERS 白名单)可编辑，其他人只读。
// - 自动列出链路里"缺价"的模型，一键补价（对接仪表盘的缺单价告警）。

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';

interface PricingRow {
    key: string;
    inputTokenPrice: number;
    outputTokenPrice: number;
    cacheReadInputTokenPrice: number | null;
    cacheCreationInputTokenPrice: number | null;
    contextWindow: number | null;
}
interface Observed { model: string; hasPricing: boolean; source: 'default' | 'custom' | null }
interface PricingResp {
    isAdmin: boolean; currency: string;
    builtin: PricingRow[]; custom: PricingRow[]; observed: Observed[];
}
interface EditRow { key: string; input: string; output: string; cacheRead: string; cacheCreation: string; ctx: string }

const s = (n: number | null | undefined) => (n == null ? '' : String(n));
const toEdit = (r: PricingRow): EditRow => ({
    key: r.key, input: s(r.inputTokenPrice), output: s(r.outputTokenPrice),
    cacheRead: s(r.cacheReadInputTokenPrice), cacheCreation: s(r.cacheCreationInputTokenPrice), ctx: s(r.contextWindow),
});

export function ModelPricingManager() {
    const { user } = useAuth();
    const [data, setData] = useState<PricingResp | null>(null);
    const [rows, setRows] = useState<EditRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
    const [showBuiltin, setShowBuiltin] = useState(false);

    const load = useCallback(async () => {
        if (!user) return;
        setLoading(true); setMsg(null);
        try {
            const res = await apiFetch(`/api/modelconfig/pricing?user=${encodeURIComponent(user)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const d: PricingResp = await res.json();
            setData(d);
            setRows(d.custom.map(toEdit));
        } catch (e) {
            setMsg({ type: 'err', text: e instanceof Error ? e.message : '加载失败' });
        } finally {
            setLoading(false);
        }
    }, [user]);
    useEffect(() => { load(); }, [load]);

    const isAdmin = !!data?.isAdmin;
    const patch = (i: number, p: Partial<EditRow>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
    const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
    const add = (key = '') => setRows((rs) => (rs.some((r) => r.key.trim() === key && key) ? rs : [...rs, { key, input: '', output: '', cacheRead: '', cacheCreation: '', ctx: '' }]));

    const save = async () => {
        if (!user) return;
        const custom: Record<string, Record<string, string>> = {};
        for (const r of rows) {
            const k = r.key.trim();
            if (!k) continue;
            custom[k] = {
                inputTokenPrice: r.input, outputTokenPrice: r.output,
                cacheReadInputTokenPrice: r.cacheRead, cacheCreationInputTokenPrice: r.cacheCreation, contextWindow: r.ctx,
            };
        }
        setSaving(true); setMsg(null);
        try {
            const res = await apiFetch(`/api/modelconfig/pricing?user=${encodeURIComponent(user)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ custom }),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
            setMsg({ type: 'ok', text: `已保存 ${j.count} 个模型单价` });
            await load();
        } catch (e) {
            setMsg({ type: 'err', text: e instanceof Error ? e.message : '保存失败' });
        } finally {
            setSaving(false);
        }
    };

    const missing = (data?.observed || []).filter((o) => !o.hasPricing);

    return (
        <div style={{ padding: '0 28px 32px', width: '100%' }}>
        <div style={{ maxWidth: 1320, margin: '0 auto' }}>
        <section style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12 }}>
            <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--foreground)' }}>模型单价</span>
                <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>按模型名(前缀)配置 · 单位 {data?.currency ?? 'USD'} / 百万 token · 用于成本计算</span>
                <span style={{ flex: 1 }} />
                {!loading && (isAdmin
                    ? <span style={{ fontSize: 10.5, color: 'var(--success)', border: '1px solid var(--success-subtle-border)', background: 'var(--success-subtle)', borderRadius: 6, padding: '2px 8px' }}>管理员 · 可编辑</span>
                    : <span style={{ fontSize: 10.5, color: 'var(--foreground-muted)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px' }}>只读 · 仅管理员可改</span>)}
            </div>

            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {loading && <div style={{ color: 'var(--foreground-muted)', fontSize: 13 }}>加载中…</div>}
                {msg && <div style={{ fontSize: 12, color: msg.type === 'ok' ? 'var(--success)' : 'var(--error)' }}>{msg.text}</div>}

                {!loading && !isAdmin && (
                    <div style={{ fontSize: 11.5, color: 'var(--foreground-muted)', background: 'var(--background-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', lineHeight: 1.6 }}>
                        模型单价为全局配置,只有管理员可修改。部署时在环境变量 <code style={{ color: 'var(--foreground-secondary)' }}>AGENT_INSIGHT_ADMIN_USERS</code>（逗号分隔用户名）中加入你的账号即可获得编辑权限。
                    </div>
                )}

                {/* 链路里缺价的模型 */}
                {!loading && missing.length > 0 && (
                    <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)', marginBottom: 8 }}>⚠ 链路中出现但缺单价的模型（{missing.length}）——成本按 0 计</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {missing.map((o) => (
                                <span key={o.model} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, border: '1px solid var(--warning-subtle-border)', background: 'var(--warning-subtle)', color: 'var(--foreground-secondary)', borderRadius: 7, padding: '3px 8px', fontFamily: 'var(--font-mono, monospace)' }}>
                                    {o.model}
                                    {isAdmin && <button onClick={() => add(o.model)} style={{ border: 'none', background: 'var(--primary)', color: '#fff', borderRadius: 5, fontSize: 10.5, padding: '1px 7px', cursor: 'pointer' }}>补价</button>}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* 自定义单价表 */}
                {!loading && (
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                                <tr>
                                    {['模型名(前缀)', 'input', 'output', '缓存读', '缓存写', '上下文窗', ''].map((h, i) => (
                                        <th key={i} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '7px 10px', color: 'var(--foreground-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r, i) => (
                                    <tr key={i}>
                                        <Cell><Inp v={r.key} on={(x) => patch(i, { key: x })} admin={isAdmin} w={200} mono placeholder="如 GLM-5" /></Cell>
                                        <Cell right><Inp v={r.input} on={(x) => patch(i, { input: x })} admin={isAdmin} w={80} num /></Cell>
                                        <Cell right><Inp v={r.output} on={(x) => patch(i, { output: x })} admin={isAdmin} w={80} num /></Cell>
                                        <Cell right><Inp v={r.cacheRead} on={(x) => patch(i, { cacheRead: x })} admin={isAdmin} w={80} num placeholder="—" /></Cell>
                                        <Cell right><Inp v={r.cacheCreation} on={(x) => patch(i, { cacheCreation: x })} admin={isAdmin} w={80} num placeholder="—" /></Cell>
                                        <Cell right><Inp v={r.ctx} on={(x) => patch(i, { ctx: x })} admin={isAdmin} w={90} num placeholder="—" /></Cell>
                                        <Cell right>{isAdmin && <button onClick={() => remove(i)} style={{ border: 'none', background: 'transparent', color: 'var(--error)', cursor: 'pointer', fontSize: 12 }}>删除</button>}</Cell>
                                    </tr>
                                ))}
                                {rows.length === 0 && (
                                    <tr><td colSpan={7} style={{ padding: 18, textAlign: 'center', color: 'var(--foreground-muted)' }}>暂无自定义单价{isAdmin ? '，点下方「添加模型」或上面缺价模型的「补价」' : ''}</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}

                {isAdmin && !loading && (
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button onClick={() => add()} style={btnGhost}>+ 添加模型</button>
                        <span style={{ flex: 1 }} />
                        <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? '保存中…' : '保存'}</button>
                    </div>
                )}

                {/* 内置价(只读参考) */}
                {!loading && data && (
                    <div>
                        <button onClick={() => setShowBuiltin((v) => !v)} style={{ border: 'none', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>
                            {showBuiltin ? '▾' : '▸'} 内置默认单价（{data.builtin.length}，只读兜底，自定义会覆盖同前缀）
                        </button>
                        {showBuiltin && (
                            <div style={{ overflowX: 'auto', marginTop: 8 }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                                    <thead><tr>{['模型名(前缀)', 'input', 'output', '缓存读', '缓存写', '上下文窗'].map((h, i) => (
                                        <th key={i} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '6px 10px', color: 'var(--foreground-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                                    ))}</tr></thead>
                                    <tbody>
                                        {data.builtin.map((b) => (
                                            <tr key={b.key} style={{ color: 'var(--foreground-secondary)' }}>
                                                <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono, monospace)' }}>{b.key}</td>
                                                <td style={tdR}>{b.inputTokenPrice}</td><td style={tdR}>{b.outputTokenPrice}</td>
                                                <td style={tdR}>{b.cacheReadInputTokenPrice ?? '—'}</td><td style={tdR}>{b.cacheCreationInputTokenPrice ?? '—'}</td>
                                                <td style={tdR}>{b.contextWindow ?? '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
        </div>
        </div>
    );
}

function Cell({ children, right }: { children: React.ReactNode; right?: boolean }) {
    return <td style={{ padding: '5px 10px', borderBottom: '1px solid var(--border)', textAlign: right ? 'right' : 'left' }}>{children}</td>;
}
function Inp({ v, on, admin, w, num, mono, placeholder }: { v: string; on: (x: string) => void; admin: boolean; w: number; num?: boolean; mono?: boolean; placeholder?: string }) {
    if (!admin) return <span style={{ fontFamily: mono || num ? 'var(--font-mono, monospace)' : undefined, color: v ? 'var(--foreground)' : 'var(--foreground-muted)' }}>{v || placeholder || '—'}</span>;
    return (
        <input value={v} onChange={(e) => on(e.target.value)} placeholder={placeholder} inputMode={num ? 'decimal' : 'text'}
            style={{ width: w, maxWidth: '100%', padding: '4px 7px', fontSize: 12, textAlign: num ? 'right' : 'left', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontFamily: mono || num ? 'var(--font-mono, monospace)' : undefined }} />
    );
}
const tdR: React.CSSProperties = { padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' };
const btnPrimary: React.CSSProperties = { border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground, #fff)', borderRadius: 8, fontSize: 12.5, fontWeight: 600, padding: '7px 18px', cursor: 'pointer' };
const btnGhost: React.CSSProperties = { border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground-secondary)', borderRadius: 8, fontSize: 12.5, padding: '7px 14px', cursor: 'pointer' };
