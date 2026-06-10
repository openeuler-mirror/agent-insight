'use client';

import React from 'react';
import { useLocale } from '@/lib/client/locale-context';
import type { QualityAgentInfo, WindowKind } from '@/lib/engine/quality-monitoring/types';

const WINDOWS: WindowKind[] = ['1d', '1w', '1m'];

export interface ConfigState {
    agent: string;
    window: WindowKind;
    skill: string;
    status: string;
}

export function QualityConfigBar({
    agents, value, onChange, skills,
}: {
    agents: QualityAgentInfo[];
    value: ConfigState;
    onChange: (patch: Partial<ConfigState>) => void;
    skills: string[];
}) {
    const { t } = useLocale();
    const winLabel: Record<string, string> = {
        '1d': t('quality.config.day'), '1w': t('quality.config.week'), '1m': t('quality.config.month'),
    };

    return (
        <section style={{
            display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
            background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 12,
            boxShadow: '0 1px 2px rgba(20,22,30,.04)', padding: '12px 18px', marginBottom: 14,
        }}>
            {/* Agent 选择 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--foreground-muted)' }}>{t('quality.config.agent')}</span>
                <div style={{ position: 'relative' }}>
                    <select
                        value={value.agent}
                        onChange={(e) => onChange({ agent: e.target.value })}
                        style={{
                            appearance: 'none', WebkitAppearance: 'none',
                            border: '1px solid var(--border)', background: 'var(--background)',
                            borderRadius: 8, padding: '7px 28px 7px 11px',
                            fontSize: 12.5, fontWeight: 700, color: 'var(--foreground)', cursor: 'pointer', outline: 'none',
                            minWidth: 150,
                        }}
                    >
                        {!value.agent && <option value="">{t('quality.config.selectAgent')}</option>}
                        {agents.map((a) => (
                            <option key={a.name} value={a.name}>
                                {a.name}{a.traceCount != null ? ` (${a.traceCount})` : ''}
                            </option>
                        ))}
                    </select>
                    <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: 'var(--foreground-muted)', pointerEvents: 'none' }}>▾</span>
                </div>
            </div>

            {/* 时间段 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--foreground-muted)' }}>{t('quality.config.timeRange')}</span>
                <div style={{ display: 'inline-flex', background: 'var(--background-secondary)', borderRadius: 9, padding: 3 }}>
                    {WINDOWS.map((w) => {
                        const on = value.window === w;
                        return (
                            <button
                                key={w}
                                onClick={() => onChange({ window: w })}
                                style={{
                                    border: 'none', background: on ? 'var(--background)' : 'transparent',
                                    color: on ? 'var(--primary)' : 'var(--foreground-secondary)',
                                    fontWeight: on ? 700 : 600, fontSize: 12, padding: '6px 13px', borderRadius: 7,
                                    cursor: 'pointer', boxShadow: on ? '0 1px 2px rgba(20,22,30,.08)' : 'none',
                                }}
                            >
                                {winLabel[w]}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* 次级过滤：Skill / 状态 */}
            <SecondarySelect label={t('quality.config.skill')} value={value.skill}
                onChange={(v) => onChange({ skill: v })}
                options={[{ value: 'all', label: t('quality.config.all') }, ...skills.map((s) => ({ value: s, label: s }))]} />
            <SecondarySelect label={t('quality.config.status')} value={value.status}
                onChange={(v) => onChange({ status: v })}
                options={[
                    { value: 'all', label: t('quality.config.all') },
                    { value: '达标', label: t('quality.status.达标') },
                    { value: '关注', label: t('quality.status.关注') },
                    { value: '异常', label: t('quality.status.异常') },
                ]} />

            <div style={{ flex: 1, minWidth: 40 }} />
        </section>
    );
}

function SecondarySelect({ label, value, onChange, options }: {
    label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
    const active = value !== 'all';
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>{label}</span>
            <div style={{ position: 'relative' }}>
                <select
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    style={{
                        appearance: 'none', WebkitAppearance: 'none',
                        border: '1px solid var(--border)', borderRadius: 7, padding: '5px 22px 5px 9px',
                        fontSize: 12, fontWeight: active ? 600 : 400,
                        background: active ? 'var(--primary-subtle)' : 'var(--background)',
                        color: active ? 'var(--primary)' : 'var(--foreground-secondary)', cursor: 'pointer', outline: 'none',
                    }}
                >
                    {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <span style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', fontSize: 8, color: 'var(--foreground-muted)', pointerEvents: 'none' }}>▾</span>
            </div>
        </div>
    );
}
