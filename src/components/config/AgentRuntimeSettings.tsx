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
import { Check, Info, RefreshCw, Save, Server, AlertTriangle } from 'lucide-react';

import { apiFetch } from '@/lib/client/api';
import { useAuth } from '@/lib/auth/auth-context';
import { useLocale } from '@/lib/client/locale-context';

type Capability =
    | 'session'
    | 'tools'
    | 'skills'
    | 'permissions'
    | 'cancel'
    | 'timeout'
    | 'trace';

interface UnavailableReason {
    code: string;
    detail?: string;
}

interface RuntimeDescriptor {
    id: string;
    displayName: string;
    installed: boolean;
    version: string | null;
    executable: string | null;
    source: 'env' | 'bundled' | 'path' | 'unknown';
    minimumVersion: string | null;
    compatible: boolean;
    adapterAvailable: boolean;
    usable: boolean;
    capabilities: Capability[];
    unavailableReason: UnavailableReason | null;
}

interface Overview {
    runtimes: RuntimeDescriptor[];
    checkedAt: string;
    defaultRuntimeId: string | null;
    selection: {
        runtimeId: string | null;
        usable: boolean;
        reason: UnavailableReason | null;
    };
}

const CAPABILITY_LABELS: Record<Capability, [string, string]> = {
    session: ['会话', 'Session'],
    tools: ['工具调用', 'Tools'],
    skills: ['Skill 加载', 'Skills'],
    permissions: ['权限控制', 'Permissions'],
    cancel: ['取消', 'Cancel'],
    timeout: ['超时', 'Timeout'],
    trace: ['Trace 归属', 'Trace'],
};

const SOURCE_LABELS: Record<RuntimeDescriptor['source'], [string, string]> = {
    env: ['环境变量', 'Environment variable'],
    bundled: ['随包安装', 'Bundled'],
    path: ['PATH', 'PATH'],
    unknown: ['未找到', 'Not found'],
};

function reasonText(reason: UnavailableReason | null, isZh: boolean): string {
    if (!reason) return '';
    switch (reason.code) {
        case 'NOT_INSTALLED':
            return isZh
                ? `未在服务部署环境中找到可执行文件（可用 ${reason.detail ?? '环境变量'} 指定路径）`
                : `Executable not found in the service deployment (set ${reason.detail ?? 'the env var'} to override)`;
        case 'CONFIGURED_PATH_MISSING':
            return isZh
                ? `${reason.detail} 指向的路径不存在或不可执行`
                : `The configured path ${reason.detail} does not exist or is not executable`;
        case 'VERSION_UNREADABLE':
            return isZh
                ? '已找到可执行文件，但无法读取版本号'
                : 'Executable found, but its version could not be read';
        case 'INCOMPATIBLE':
            return isZh
                ? `版本不兼容（${reason.detail}）`
                : `Incompatible version (${reason.detail})`;
        case 'NO_ADAPTER':
            return isZh
                ? '平台尚未提供该运行时的执行适配器，找到可执行文件也不能执行平台任务'
                : 'The platform has no execution adapter for this runtime yet; finding the executable is not enough to run platform tasks';
        case 'UNKNOWN_RUNTIME':
            return isZh
                ? `已保存的运行时 ${reason.detail} 不再受支持`
                : `The saved runtime ${reason.detail} is no longer supported`;
        default:
            return reason.detail ?? reason.code;
    }
}

export function AgentRuntimeSettings() {
    const { user } = useAuth();
    const { locale } = useLocale();
    const isZh = locale === 'zh';

    const [overview, setOverview] = useState<Overview | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [savedId, setSavedId] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);

    const applyOverview = useCallback((data: Overview) => {
        setOverview(data);
        setSelectedId(data.selection.runtimeId);
        setSavedId(data.selection.runtimeId);
    }, []);

    const load = useCallback(async (refresh = false) => {
        if (!user) {
            setLoaded(true);
            return;
        }
        try {
            const query = `/api/agent-runtimes?user=${encodeURIComponent(user)}${refresh ? '&refresh=1' : ''}`;
            const res = await apiFetch(query);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setStatus({ type: 'error', msg: (isZh ? '检测失败：' : 'Detection failed: ') + (body.error || res.statusText) });
                return;
            }
            applyOverview(await res.json());
        } catch (error) {
            setStatus({
                type: 'error',
                msg: (isZh ? '检测失败：' : 'Detection failed: ') + (error instanceof Error ? error.message : String(error)),
            });
        } finally {
            setLoaded(true);
        }
    }, [applyOverview, isZh, user]);

    useEffect(() => {
        queueMicrotask(() => { void load(false); });
    }, [load]);

    const onRefresh = async () => {
        setIsRefreshing(true);
        setStatus(null);
        await load(true);
        setIsRefreshing(false);
    };

    const onSave = async () => {
        if (!user) return;
        setIsSaving(true);
        setStatus({ type: 'info', msg: isZh ? '保存中…' : 'Saving…' });
        try {
            const res = await apiFetch('/api/agent-runtimes', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, runtimeId: selectedId }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const reason = body.reason ? reasonText(body.reason, isZh) : body.error || res.statusText;
                setStatus({ type: 'error', msg: (isZh ? '保存失败：' : 'Save failed: ') + reason });
                return;
            }
            applyOverview(body as Overview);
            setStatus({
                type: 'success',
                msg: isZh
                    ? '已保存个人默认值。当前版本仅 OpenCode 提供执行适配器，平台执行路径保持不变；偏好只影响后续接入的引擎。'
                    : 'Personal default saved. Only OpenCode has an execution adapter today, so platform execution is unchanged; the preference applies to engines wired in later.',
            });
        } catch (error) {
            setStatus({
                type: 'error',
                msg: (isZh ? '保存失败：' : 'Save failed: ') + (error instanceof Error ? error.message : String(error)),
            });
        } finally {
            setIsSaving(false);
        }
    };

    const dirty = overview != null && selectedId !== savedId;
    const noUsableRuntime = useMemo(
        () => Boolean(overview) && !overview?.runtimes.some(runtime => runtime.usable),
        [overview],
    );

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
                            <>
                                平台内置的 Skill 生成、优化、诊断与评测会用<b style={descStrong}>当前服务部署环境</b>中的 Agent 运行时执行任务。
                                这里的检测只扫描服务进程可访问的可执行文件，<b style={descStrong}>不调用模型、不自动安装或升级依赖</b>；
                                保存的默认值只影响新任务和新会话。当前版本仅 OpenCode 具备执行适配器，平台执行路径保持不变。
                            </>
                        ) : (
                            <>
                                Built-in Skill generation, optimization, diagnosis, and evaluation run on an Agent runtime accessible from <b style={descStrong}>this service deployment</b>.
                                Detection only scans executables the service process can reach — <b style={descStrong}>it never calls a model or installs/upgrades anything</b>.
                                The saved default only affects new tasks and sessions. Today only OpenCode has an execution adapter, so platform execution is unchanged.
                            </>
                        )}
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                        <button onClick={onRefresh} disabled={isRefreshing || !user} style={secondaryBtn}>
                            <RefreshCw size={14} strokeWidth={2.2}  />
                            {isZh ? '重新检测' : 'Re-detect'}
                        </button>
                        <button onClick={onSave} disabled={isSaving || !user || !dirty} style={isSaving || !user || !dirty ? primaryBtnDisabled : primaryBtn}>
                            <Save size={14} strokeWidth={2.4} />
                            {isSaving ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '保存' : 'Save')}
                        </button>
                    </div>
                </div>

                {overview && (
                    <div style={metaRow}>
                        <Server size={12} strokeWidth={2.2} />
                        <span>
                            {isZh ? '上次检测 ' : 'Last checked '}
                            {new Date(overview.checkedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
                        </span>
                        <span style={{ color: 'var(--foreground-muted)' }}>·</span>
                        <span>
                            {isZh ? '平台默认：' : 'Platform default: '}
                            {overview.runtimes.find(r => r.id === overview.defaultRuntimeId)?.displayName ?? (isZh ? '无可用运行时' : 'none available')}
                        </span>
                    </div>
                )}

                {noUsableRuntime && (
                    <div style={hintBox}>
                        <div style={hintIcon}><AlertTriangle size={16} /></div>
                        <div style={{ flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.6 }}>
                            {isZh
                                ? '当前部署环境没有可执行平台任务的运行时。请检查服务容器的安装情况或 OPENCODE_BIN 配置；平台不会静默切换到其他引擎。'
                                : 'No runtime in this deployment can execute platform tasks. Check the service container installation or OPENCODE_BIN. The platform will not silently switch engines.'}
                        </div>
                    </div>
                )}

                <section style={listCard}>
                    <button
                        type="button"
                        onClick={() => setSelectedId(null)}
                        style={selectedId === null ? optionRowActive : optionRow}
                    >
                        <Radio checked={selectedId === null} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
                                    {isZh ? '平台默认' : 'Platform default'}
                                </span>
                                {savedId === null && <span style={badgeMuted}>{isZh ? '当前偏好' : 'Current'}</span>}
                            </div>
                            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--foreground-muted)' }}>
                                {isZh
                                    ? '不保存个人偏好，由部署侧决定使用哪个运行时。'
                                    : 'Do not store a personal preference; the deployment chooses the runtime.'}
                            </div>
                        </div>
                    </button>

                    {overview?.runtimes.map((runtime) => {
                        const selected = selectedId === runtime.id;
                        const selectable = runtime.usable;
                        return (
                            <div
                                key={runtime.id}
                                role="button"
                                aria-disabled={!selectable}
                                tabIndex={selectable ? 0 : -1}
                                onClick={() => selectable && setSelectedId(runtime.id)}
                                onKeyDown={(event) => {
                                    if (selectable && (event.key === 'Enter' || event.key === ' ')) {
                                        event.preventDefault();
                                        setSelectedId(runtime.id);
                                    }
                                }}
                                style={{
                                    ...(selected ? optionRowActive : optionRow),
                                    cursor: selectable ? 'pointer' : 'not-allowed',
                                    opacity: selectable ? 1 : 0.8,
                                }}
                            >
                                <Radio checked={selected} disabled={!selectable} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>{runtime.displayName}</span>
                                        <StatusBadge runtime={runtime} isZh={isZh} />
                                        {savedId === runtime.id && <span style={badgeMuted}>{isZh ? '当前偏好' : 'Current'}</span>}
                                    </div>

                                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11.5, color: 'var(--foreground-muted)' }}>
                                        <span>
                                            {isZh ? '版本 ' : 'Version '}
                                            <code style={inlineCode}>{runtime.version ?? '—'}</code>
                                            {runtime.minimumVersion && (
                                                <span> {isZh ? `（最低 ${runtime.minimumVersion}）` : `(min ${runtime.minimumVersion})`}</span>
                                            )}
                                        </span>
                                        <span>
                                            {isZh ? '来源 ' : 'Source '}
                                            {isZh ? SOURCE_LABELS[runtime.source][0] : SOURCE_LABELS[runtime.source][1]}
                                        </span>
                                        {runtime.executable && (
                                            <span style={{ wordBreak: 'break-all' }}>
                                                {isZh ? '路径 ' : 'Path '}
                                                <code style={inlineCode}>{runtime.executable}</code>
                                            </span>
                                        )}
                                    </div>

                                    {runtime.usable && runtime.capabilities.length > 0 && (
                                        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                            {runtime.capabilities.map((capability) => (
                                                <span key={capability} style={capabilityChip}>
                                                    {isZh ? CAPABILITY_LABELS[capability][0] : CAPABILITY_LABELS[capability][1]}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {!runtime.usable && runtime.unavailableReason && (
                                        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: 'var(--error, #b91c1c)' }}>
                                            {reasonText(runtime.unavailableReason, isZh)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </section>

                <div style={hintBox}>
                    <div style={hintIcon}><Info size={16} /></div>
                    <div style={{ flex: 1, fontSize: 12.5, color: 'var(--foreground-secondary)', lineHeight: 1.6 }}>
                        {isZh
                            ? '容器内检测到的结果不代表宿主机或浏览器所在电脑的安装情况。可执行文件存在也不等于具备平台执行能力：只有适配器已提供、版本兼容且满足任务所需能力的运行时才能被选择。'
                            : 'Detection inside the container does not reflect the host machine or the browser computer. An executable alone is not enough: only runtimes with a provided adapter, a compatible version, and the capabilities a task needs can be selected.'}
                    </div>
                </div>
            </div>
        </div>
    );
}

function StatusBadge({ runtime, isZh }: { runtime: RuntimeDescriptor; isZh: boolean }) {
    if (runtime.usable) {
        return (
            <span style={badgeHealthy}>
                <Check size={11} strokeWidth={2.5} />
                {isZh ? '可用' : 'Available'}
            </span>
        );
    }
    if (!runtime.installed) {
        return <span style={badgeMuted}>{isZh ? '未安装' : 'Not installed'}</span>;
    }
    return (
        <span style={badgeWarn}>
            <AlertTriangle size={11} strokeWidth={2.4} />
            {isZh ? '不可用' : 'Unavailable'}
        </span>
    );
}

function Radio({ checked, disabled }: { checked: boolean; disabled?: boolean }) {
    return (
        <span
            aria-hidden
            style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: `1.5px solid ${checked ? 'var(--primary)' : 'var(--border-dark)'}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                marginTop: 3,
                background: disabled ? 'var(--background-secondary)' : 'transparent',
            }}
        >
            {checked && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)' }} />}
        </span>
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

/* ====================== Styles ====================== */

const pageWrap: CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--background)' };
const pageInner: CSSProperties = { maxWidth: 1080, margin: '0 auto', padding: '26px 28px 60px' };
const introRow: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 };
const descText: CSSProperties = { flex: 1, minWidth: 0, margin: 0, fontSize: 13, lineHeight: 1.75, color: 'var(--foreground-secondary)' };
const descStrong: CSSProperties = { color: 'var(--foreground)', fontWeight: 600 };
const inlineCode: CSSProperties = {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11,
    padding: '1px 5px',
    borderRadius: 4,
    background: 'var(--background-secondary)',
    color: 'var(--foreground)',
};
const metaRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
    fontSize: 11.5,
    color: 'var(--foreground-muted)',
};
const listCard: CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg, 10px)',
    background: 'var(--card-bg)',
    overflow: 'hidden',
};
const optionRow: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    width: '100%',
    padding: '16px 18px',
    border: 'none',
    borderBottom: '1px solid var(--border)',
    background: 'transparent',
    textAlign: 'left',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
};
const optionRowActive: CSSProperties = {
    ...optionRow,
    background: 'var(--primary-subtle)',
};
const badgeBase: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10.5,
    fontWeight: 600,
    padding: '2px 7px',
    borderRadius: 999,
    lineHeight: 1.5,
};
const badgeHealthy: CSSProperties = { ...badgeBase, background: 'var(--success-subtle)', color: 'var(--success)' };
const badgeWarn: CSSProperties = { ...badgeBase, background: 'var(--warning-subtle, var(--error-subtle))', color: 'var(--warning, var(--error))' };
const badgeMuted: CSSProperties = { ...badgeBase, background: 'var(--background-secondary)', color: 'var(--foreground-muted)' };
const capabilityChip: CSSProperties = {
    fontSize: 10.5,
    padding: '2px 7px',
    borderRadius: 999,
    background: 'var(--background-secondary)',
    border: '1px solid var(--border)',
    color: 'var(--foreground-secondary)',
};
const primaryBtn: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--primary-foreground)',
    background: 'var(--primary)',
    border: '1px solid var(--primary)',
    borderRadius: 8,
    cursor: 'pointer',
};
const primaryBtnDisabled: CSSProperties = { ...primaryBtn, opacity: 0.5, cursor: 'not-allowed' };
const secondaryBtn: CSSProperties = {
    ...primaryBtn,
    color: 'var(--foreground-secondary)',
    background: 'var(--card-bg)',
    border: '1px solid var(--border)',
};
const hintBox: CSSProperties = {
    display: 'flex',
    gap: 10,
    alignItems: 'flex-start',
    marginTop: 16,
    padding: '12px 14px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--background-secondary)',
};
const hintIcon: CSSProperties = { color: 'var(--foreground-muted)', flexShrink: 0, marginTop: 1 };
