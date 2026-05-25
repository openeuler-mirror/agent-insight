'use client';

import { useLocale } from '@/lib/client/locale-context';
import { AppTopBar } from '@/components/shell/AppTopBar';

export interface ComingSoonProps {
    /** Page title shown in the top bar */
    title: string;
    /** Short hifi-aligned tagline shown above the title */
    tagline?: string;
    /** Bullet list of capabilities planned for this module */
    capabilities?: { label: string; desc?: string }[];
    /** Right-side actions on the top bar */
    actions?: React.ReactNode;
}

export function ComingSoon({ title, tagline, capabilities, actions }: ComingSoonProps) {
    const { t } = useLocale();
    return (
        <>
            <AppTopBar title={title} actions={actions} />
            <div style={{ padding: '24px 24px', maxWidth: 880, margin: '0 auto' }}>
                <div
                    style={{
                        background: 'var(--card-bg)',
                        border: '1px solid var(--card-border)',
                        borderRadius: 12,
                        padding: '36px 32px',
                        textAlign: 'center',
                    }}
                >
                    <div
                        style={{
                            width: 56,
                            height: 56,
                            margin: '0 auto 14px',
                            borderRadius: 14,
                            background: 'var(--primary-subtle)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--primary)',
                        }}
                    >
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 7v5l3 2" />
                        </svg>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
                        {t('topbar.comingSoon')}
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--foreground)', marginBottom: 4 }}>{title}</div>
                    {tagline && (
                        <div style={{ fontSize: 12, color: 'var(--foreground-muted)', maxWidth: 540, margin: '0 auto', lineHeight: 1.6 }}>
                            {tagline}
                        </div>
                    )}
                    <div
                        style={{
                            margin: '20px auto 0',
                            maxWidth: 540,
                            padding: '12px 14px',
                            background: 'var(--background-secondary)',
                            border: '1px dashed var(--border)',
                            borderRadius: 9,
                            fontSize: 11.5,
                            color: 'var(--foreground-secondary)',
                            lineHeight: 1.7,
                        }}
                    >
                        {t('comingSoon.body')}
                    </div>
                </div>

                {capabilities && capabilities.length > 0 && (
                    <div style={{ marginTop: 20 }}>
                        <div style={{ fontSize: 11, color: 'var(--foreground-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10 }}>
                            Roadmap
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 9 }}>
                            {capabilities.map((c, i) => (
                                <div
                                    key={i}
                                    style={{
                                        background: 'var(--card-bg)',
                                        border: '1px solid var(--card-border)',
                                        borderRadius: 9,
                                        padding: '11px 13px',
                                    }}
                                >
                                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--foreground)', marginBottom: 4 }}>
                                        {c.label}
                                    </div>
                                    {c.desc && (
                                        <div style={{ fontSize: 11, color: 'var(--foreground-muted)', lineHeight: 1.5 }}>
                                            {c.desc}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
