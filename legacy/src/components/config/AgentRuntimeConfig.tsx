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

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
    Check,
    CircleAlert,
    Cpu,
    Info,
    RefreshCw,
    Save,
    Server,
} from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';
import type {
    AgentRuntimeCapability,
    AgentRuntimeDescriptor,
    AgentRuntimePreference,
    AgentRuntimeStatus,
} from '@/lib/agent-runtime/types';

interface RuntimeResponse {
    runtimes: AgentRuntimeDescriptor[];
    checkedAt: string;
    preference: AgentRuntimePreference;
}

const CAPABILITY_LABELS: Record<AgentRuntimeCapability, { zh: string; en: string }> = {
    'tool-policy': { zh: '工具策略', en: 'Tool policy' },
    'session-resume': { zh: '会话续接', en: 'Session resume' },
    cancel: { zh: '取消确认', en: 'Cancel' },
    timeout: { zh: '超时回收', en: 'Timeout' },
    'skill-loading': { zh: 'Skill 加载', en: 'Skill loading' },
    'trace-attribution': { zh: 'Trace 归属', en: 'Trace attribution' },
};

const STATUS_LABELS: Record<AgentRuntimeStatus, { zh: string; en: string }> = {
    available: { zh: '可用', en: 'Available' },
    'not-installed': { zh: '未安装', en: 'Not installed' },
    'adapter-missing': { zh: '未适配', en: 'Adapter missing' },
    'probe-failed': { zh: '检测失败', en: 'Probe failed' },
    'incompatible-version': { zh: '版本不兼容', en: 'Incompatible' },
};

const SOURCE_LABELS: Record<string, { zh: string; en: string }> = {
    environment: { zh: '环境变量', en: 'Environment variable' },
    bundled: { zh: '平台内置包', en: 'Bundled package' },
    path: { zh: 'PATH', en: 'PATH' },
};

/** 服务端枚举可能先于前端扩展；未知 key 回退显示原始值，避免整页渲染崩溃。 */
function labelOf<K extends string>(
    labels: Partial<Record<K, { zh: string; en: string }>>,
    key: K,
    isZh: boolean,
): string {
    const entry = labels[key];
    if (!entry) return key;
    return isZh ? entry.zh : entry.en;
}

function statusTone(status: AgentRuntimeStatus) {
    if (status === 'available') {
        return { bg: 'var(--success-subtle)', fg: 'var(--success)' };
    }
    if (status === 'incompatible-version' || status === 'probe-failed') {
        return { bg: 'var(--warning-subtle)', fg: 'var(--warning)' };
    }
    return { bg: 'var(--background-secondary)', fg: 'var(--foreground-muted)' };
}

export function AgentRuntimeConfig() {
    const { user, authReady } = useAuth();
    const { locale } = useLocale();
    const isZh = locale === 'zh';

    const [data, setData] = useState<RuntimeResponse | null>(null);
    const [selected, setSelected] = useState<string>('');
    const [loaded, setLoaded] = useState(false);
    const [detecting, setDetecting] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);

    const refresh = useCallback(async (force = false) => {
        try {
            if (!user) {
                setData(null);
                setStatus({
                    type: 'error',
                    msg: isZh
                        ? '未获取到登录用户，无法读取个人运行时默认值。请登录后重试。'
                        : 'No signed-in user, so the personal runtime default cannot be read. Sign in and retry.',
                });
                return;
            }
            const res = await apiFetch(
                `/api/agent-runtime?user=${encodeURIComponent(user)}${force ? '&refresh=1' : ''}`,
            );
            if (!res.ok) throw new Error(res.statusText);
            const next = (await res.json()) as RuntimeResponse;
            setData(next);
            setSelected(next.preference.selectedId ?? '');
        } catch (error) {
            setStatus({
                type: 'error',
                msg: (isZh ? '检测失败：' : 'Detection failed: ')
                    + (error instanceof Error ? error.message : String(error)),
            });
        } finally {
            setDetecting(false);
            setLoaded(true);
        }
    }, [user, isZh]);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- 首次进入拉取运行时检测结果
    useEffect(() => { if (authReady) void refresh(false); }, [authReady, refresh]);

    const runtimes = useMemo(() => data?.runtimes ?? [], [data]);
    const selectable = useMemo(() => runtimes.filter(item => item.selectable), [runtimes]);
    const effective = data?.preference.runtime ?? null;
    const dirty = (data?.preference.selectedId ?? '') !== selected;

    const onSave = async () => {
        if (!user) return;
        setSaving(true);
        setStatus({ type: 'info', msg: isZh ? '保存中…' : 'Saving…' });
        try {
            const res = await apiFetch('/api/agent-runtime', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, runtimeId: selected || null }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setStatus({ type: 'error', msg: body.error || res.statusText });
                return;
            }
            setData(body as RuntimeResponse);
            setSelected((body as RuntimeResponse).preference.selectedId ?? '');
            setStatus({
                type: 'success',
                msg: isZh
                    ? '已保存。仅对之后新建的任务和会话生效。'
                    : 'Saved. Applies only to new tasks and sessions.',
            });
            setTimeout(() => setStatus(null), 3000);
        } catch (error) {
            setStatus({
                type: 'error',
                msg: (isZh ? '保存失败：' : 'Save failed: ')
                    + (error instanceof Error ? error.message : String(error)),
            });
        } finally {
            setSaving(false);
        }
    };

    if (!loaded) {
        return <div style={{ padding: 32, color: 'var(--foreground-muted)', fontSize: 12 }}>{isZh ? '加载中…' : 'Loading…'}</div>;
    }

    return (
        <div style={pageWrap}>
            <div style={pageInner}>
                {status && <StatusBar status={status} />}

                <div style={introRow}>
                    <p style={descText}>
                        {isZh ? (
                            <>平台内置的 Skill 生成、优化与诊断任务会在这里选择的 <b style={descStrong}>Agent 运行时</b>上执行。检测范围仅限当前平台服务实际可访问的部署环境；容器内结果不代表宿主机或浏览器所在电脑。检测不会调用模型，也不会自动安装或升级依赖。</>
                        ) : (
                            <>Platform capabilities such as Skill generation, optimization, and diagnosis run on the <b style={descStrong}>Agent runtime</b> selected here. Detection only covers the environment reachable by this platform service; results inside a container do not describe the host machine or the browser. It never calls a model or installs/upgrades dependencies.</>
                        )}
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <button onClick={() => { setDetecting(true); void refresh(true); }} disabled={detecting || !user} style={detecting || !user ? secondaryBtnDisabled : secondaryBtn}>
                            <RefreshCw size={14} strokeWidth={2.2} style={detecting ? { animation: 'spin 1s linear infinite' } : undefined} />
                            {isZh ? '重新检测' : 'Re-detect'}
                        </button>
                        <button onClick={onSave} disabled={saving || !user || !dirty} style={saving || !user || !dirty ? primaryBtnDisabled : primaryBtn}>
                            <Save size={14} strokeWidth={2.4} />
                            {saving ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '保存' : 'Save')}
                        </button>
                    </div>
                </div>

                <div style={twoColGrid}>
                    <div style={mainCol}>
                        <section style={editCard}>
                            <label style={defaultOption}>
                                <input
                                    type="radio"
                                    name="agent-runtime"
                                    checked={selected === ''}
                                    onChange={() => setSelected('')}
                                />
                                <span>
                                    <span style={optionTitle}>{isZh ? '平台默认（自动）' : 'Platform default (auto)'}</span>
                                    <span style={optionHint}>
                                        {isZh
                                            ? '按优先级选择第一个可选运行时（Pi 优先，其次 OpenCode）；当前仅已适配的运行时会被选中。'
                                            : 'Pick the first selectable runtime by priority (Pi first, then OpenCode); only adapters that have shipped are eligible.'}
                                    </span>
                                </span>
                            </label>
                        </section>

                        {runtimes.map(runtime => (
                            <RuntimeCard
                                key={runtime.id}
                                runtime={runtime}
                                isZh={isZh}
                                checked={selected === runtime.id}
                                disabled={!runtime.selectable}
                                onSelect={() => setSelected(runtime.id)}
                            />
                        ))}

                        <div style={hintBox}>
                            <div style={hintIcon}><Info size={16} /></div>
                            <div style={{ flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.6 }}>
                                <b style={{ color: 'var(--foreground)', fontWeight: 600 }}>{isZh ? '生效范围' : 'Scope'}</b>
                                {' · '}
                                {isZh
                                    ? '更换默认值只影响新任务和新会话；进行中的任务与历史会话保持原运行时绑定，不会跨引擎复用原生 Session ID。所选运行时不可用或能力不足时会明确报错，不会静默换引擎或放宽权限。'
                                    : 'Changing the default affects only new tasks and sessions. In-flight tasks and historical sessions stay bound to their original runtime, and native session IDs are never reused across engines. An unavailable or under-capable runtime fails explicitly instead of silently switching engines or relaxing permissions.'}
                            </div>
                        </div>
                    </div>

                    <aside style={sideCol}>
                        <section style={panelCard}>
                            <header style={panelHeader}>
                                <Cpu size={13} strokeWidth={2.2} style={{ color: 'var(--primary)' }} />
                                <span>{isZh ? '当前生效' : 'Effective now'}</span>
                            </header>
                            <ul style={panelKv}>
                                <KvRow
                                    label={isZh ? '运行时' : 'Runtime'}
                                    value={effective ? `${effective.label}${effective.version ? ` ${effective.version}` : ''}` : (isZh ? '无可用运行时' : 'None available')}
                                    bold
                                />
                                <KvRow
                                    label={isZh ? '来源' : 'Source'}
                                    value={data?.preference.source === 'user'
                                        ? (isZh ? '个人默认值' : 'Personal default')
                                        : data?.preference.source === 'platform-default'
                                            ? (isZh ? '平台默认' : 'Platform default')
                                            : (isZh ? '无' : 'None')}
                                />
                                <KvRow
                                    label={isZh ? '可选项' : 'Selectable'}
                                    value={selectable.length ? selectable.map(item => item.label).join(' · ') : (isZh ? '无' : 'None')}
                                />
                                <KvRow
                                    label={isZh ? '检测时间' : 'Detected at'}
                                    value={data ? new Date(data.checkedAt).toLocaleString() : '—'}
                                />
                            </ul>
                            {data?.preference.diagnostic && (
                                <div style={diagBox}>
                                    <CircleAlert size={13} strokeWidth={2.2} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                                    <span>{data.preference.diagnostic.message}</span>
                                </div>
                            )}
                        </section>

                        <section style={panelCard}>
                            <header style={panelHeader}>
                                <Server size={13} strokeWidth={2.2} style={{ color: 'var(--foreground-muted)' }} />
                                <span>{isZh ? '检测说明' : 'Detection notes'}</span>
                            </header>
                            <div style={{ fontSize: 12, color: 'var(--foreground-secondary)', lineHeight: 1.65 }}>
                                {isZh
                                    ? '找到可执行文件不等于具备平台执行能力：只有存在适配器、版本兼容且满足任务所需能力的安装才可选择。'
                                    : 'Finding an executable does not imply platform support: only compatible installations with a delivered adapter can be selected.'}
                            </div>
                        </section>
                    </aside>
                </div>
            </div>
        </div>
    );
}

function RuntimeCard({
    runtime, isZh, checked, disabled, onSelect,
}: {
    runtime: AgentRuntimeDescriptor;
    isZh: boolean;
    checked: boolean;
    disabled: boolean;
    onSelect: () => void;
}) {
    const tone = statusTone(runtime.status);
    const statusLabel = labelOf(STATUS_LABELS, runtime.status, isZh);
    const capabilities = Object.entries(runtime.capabilities) as Array<[AgentRuntimeCapability, boolean]>;

    return (
        <section style={{ ...runtimeCard, borderColor: checked ? 'var(--primary)' : 'var(--card-border)' }}>
            <label style={{ ...runtimeHeader, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                <input
                    type="radio"
                    name="agent-runtime"
                    checked={checked}
                    disabled={disabled}
                    onChange={onSelect}
                />
                <span style={optionTitle}>{runtime.label}</span>
                <span style={{ ...badge, background: tone.bg, color: tone.fg }}>
                    {runtime.status === 'available' && <Check size={11} strokeWidth={2.5} />}
                    {statusLabel}
                </span>
                {runtime.version && <span style={versionText}>v{runtime.version}</span>}
            </label>

            <div style={metaGrid}>
                <MetaRow
                    label={isZh ? '可执行文件' : 'Executable'}
                    value={runtime.executable?.path ?? (isZh ? '未找到' : 'Not found')}
                    mono
                />
                <MetaRow
                    label={isZh ? '来源' : 'Source'}
                    value={runtime.executable
                        ? (SOURCE_LABELS[runtime.executable.source]
                            ? (isZh ? SOURCE_LABELS[runtime.executable.source].zh : SOURCE_LABELS[runtime.executable.source].en)
                            : runtime.executable.source)
                        : '—'}
                />
                <MetaRow
                    label={isZh ? '最低版本' : 'Minimum version'}
                    value={runtime.minimumVersion}
                    mono
                />
            </div>

            <div style={capabilityRow}>
                {capabilities.map(([key, enabled]) => {
                    const label = labelOf(CAPABILITY_LABELS, key, isZh);
                    return (
                        <span
                            key={key}
                            style={{
                                ...capabilityChip,
                                borderColor: enabled ? 'var(--success-subtle-border)' : 'var(--border)',
                                color: enabled ? 'var(--success)' : 'var(--foreground-muted)',
                                background: enabled ? 'var(--success-subtle)' : 'transparent',
                            }}
                        >
                            {enabled ? '✓' : '—'} {label}
                        </span>
                    );
                })}
            </div>

            {runtime.diagnostics.map(item => (
                <div key={item.code} style={diagBox}>
                    <CircleAlert size={13} strokeWidth={2.2} style={{ color: runtime.status === 'available' ? 'var(--success)' : 'var(--warning)', flexShrink: 0 }} />
                    <span>{item.message}</span>
                </div>
            ))}
        </section>
    );
}

function StatusBar({ status }: { status: { type: 'success' | 'error' | 'info'; msg: string } }) {
    const tone = status.type === 'success'
        ? { bg: 'var(--success-subtle)', fg: 'var(--success)', border: 'var(--success-subtle-border)' }
        : status.type === 'error'
            ? { bg: 'var(--error-subtle)', fg: 'var(--error)', border: 'var(--error-subtle-border)' }
            : { bg: 'var(--primary-subtle)', fg: 'var(--primary)', border: 'var(--primary-subtle-border)' };
    return (
        <div style={{
            padding: '8px 12px',
            marginBottom: 14,
            borderRadius: 8,
            background: tone.bg,
            color: tone.fg,
            border: `1px solid ${tone.border}`,
            fontSize: 12,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
        }}>
            {status.type === 'success' && <Check size={13} strokeWidth={2.5} />}
            {status.msg}
        </div>
    );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div style={metaRow}>
            <span style={metaLabel}>{label}</span>
            <span style={{ ...metaValue, ...(mono ? monoText : {}) }}>{value}</span>
        </div>
    );
}

function KvRow({ label, value, bold, mono }: { label: string; value: string; bold?: boolean; mono?: boolean }) {
    return (
        <li style={kvRow}>
            <span style={kvLabel}>{label}</span>
            <span style={{ ...kvValue, ...(bold ? { fontWeight: 600, color: 'var(--foreground)' } : {}), ...(mono ? monoText : {}) }}>
                {value}
            </span>
        </li>
    );
}

/* ====================== Styles ====================== */

const pageWrap: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '24px 28px 40px',
    width: '100%',
};

const pageInner: CSSProperties = {
    maxWidth: 1320,
    margin: '0 auto',
};

const introRow: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 24,
    marginBottom: 22,
};

const descText: CSSProperties = {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.65,
    color: 'var(--foreground-secondary)',
    maxWidth: 720,
};

const descStrong: CSSProperties = {
    color: 'var(--foreground)',
    fontWeight: 600,
};

const twoColGrid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 300px',
    gap: 22,
    alignItems: 'flex-start',
};

const mainCol: CSSProperties = {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
};

const sideCol: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    position: 'sticky',
    top: 0,
};

const editCard: CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 12,
    padding: '16px 20px',
};

const runtimeCard: CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 12,
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
};

const runtimeHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
};

const defaultOption: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    cursor: 'pointer',
};

const optionTitle: CSSProperties = {
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--foreground)',
};

const optionHint: CSSProperties = {
    display: 'block',
    marginTop: 3,
    fontSize: 12,
    color: 'var(--foreground-muted)',
    lineHeight: 1.55,
};

const badge: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    fontSize: 10.5,
    fontWeight: 600,
    borderRadius: 999,
    lineHeight: 1.5,
    letterSpacing: '0.01em',
};

const versionText: CSSProperties = {
    fontSize: 11.5,
    color: 'var(--foreground-muted)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
};

const metaGrid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '8px 16px',
};

const metaRow: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
};

const metaLabel: CSSProperties = {
    fontSize: 11,
    color: 'var(--foreground-muted)',
};

const metaValue: CSSProperties = {
    fontSize: 12,
    color: 'var(--foreground-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

const monoText: CSSProperties = {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11.5,
};

const capabilityRow: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
};

const capabilityChip: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    fontSize: 10.5,
    fontWeight: 500,
    lineHeight: 1.6,
};

const diagBox: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 7,
    padding: '8px 10px',
    borderRadius: 8,
    background: 'var(--background-secondary)',
    border: '1px solid var(--border)',
    fontSize: 11.5,
    color: 'var(--foreground-secondary)',
    lineHeight: 1.55,
};

const hintBox: CSSProperties = {
    marginTop: 4,
    padding: '14px 18px',
    border: '1px dashed var(--border-dark)',
    borderRadius: 10,
    background: 'var(--background-secondary)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
};

const hintIcon: CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'var(--primary-subtle)',
    color: 'var(--primary)',
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
};

const panelCard: CSSProperties = {
    background: 'var(--card-bg)',
    border: '1px solid var(--card-border)',
    borderRadius: 12,
    padding: '14px 16px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
};

const panelHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--foreground)',
    letterSpacing: '-0.005em',
    paddingBottom: 8,
    borderBottom: '1px solid var(--border)',
};

const panelKv: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    padding: 0,
    margin: 0,
    listStyle: 'none',
};

const kvRow: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    padding: '5px 0',
    fontSize: 12,
};

const kvLabel: CSSProperties = {
    color: 'var(--foreground-muted)',
    flexShrink: 0,
};

const kvValue: CSSProperties = {
    color: 'var(--foreground-secondary)',
    textAlign: 'right',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

const primaryBtn: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 14px',
    background: 'var(--primary)',
    color: 'var(--primary-foreground)',
    border: 'none',
    borderRadius: 8,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer',
    lineHeight: 1.4,
    flexShrink: 0,
};

const primaryBtnDisabled: CSSProperties = {
    ...primaryBtn,
    opacity: 0.6,
    cursor: 'not-allowed',
};

const secondaryBtn: CSSProperties = {
    ...primaryBtn,
    background: 'transparent',
    color: 'var(--foreground-secondary)',
    border: '1px solid var(--border)',
};

const secondaryBtnDisabled: CSSProperties = {
    ...secondaryBtn,
    opacity: 0.6,
    cursor: 'not-allowed',
};
