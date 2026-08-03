'use client';

import { useLocale } from '@/lib/client/locale-context';

const PLATFORMS = [
  { key: 'openjiuwen', label: 'openjiuwen', mode: 'full' },
  { key: 'opencode', label: 'OpenCode', mode: 'thin' },
  { key: 'hermes', label: 'Hermes', mode: 'skeleton' },
  { key: 'openclaw', label: 'OpenClaw', mode: 'skeleton' },
] as const;

interface Props {
  selected: string;
  onSelect: (platform: string) => void;
}

export function PlatformSelector({ selected, onSelect }: Props) {
  const { locale } = useLocale();

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {locale === 'zh' ? '选择平台' : 'Select Platform'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PLATFORMS.map(p => (
          <button
            key={p.key}
            onClick={() => onSelect(p.key)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: selected === p.key ? '2px solid var(--primary)' : '1px solid var(--border)',
              background: selected === p.key ? 'var(--primary-subtle)' : 'var(--card-bg)',
              color: selected === p.key ? 'var(--primary)' : 'var(--foreground-secondary)',
              fontWeight: selected === p.key ? 600 : 400,
              fontSize: 13,
              cursor: 'pointer',
              transition: 'all 0.15s',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>{p.label}</span>
            {p.mode !== 'full' && (
              <span style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 10,
                background: p.mode === 'thin' ? 'var(--tag-blue-bg)' : 'var(--tag-amber-bg)',
                color: p.mode === 'thin' ? 'var(--tag-blue-fg)' : 'var(--tag-amber-fg)',
              }}>
                {p.mode === 'thin'
                  ? (locale === 'zh' ? '薄插件' : 'thin plugin')
                  : (locale === 'zh' ? '骨架' : 'skeleton')}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
