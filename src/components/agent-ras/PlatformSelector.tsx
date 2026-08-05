'use client'

import { useLocale } from '@/lib/client/locale-context'
import {
  platformSupportsSync,
  type RasCapabilityPlatformId,
} from '@/lib/ingest/ras/capability-config'

type PlatformMeta = {
  key: RasCapabilityPlatformId
  label: string
}

const PLATFORMS: PlatformMeta[] = [
  { key: 'openjiuwen', label: 'openjiuwen' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'xiaoo', label: 'xiaoO' },
]

interface Props {
  selected: string
  onSelect: (platform: RasCapabilityPlatformId) => void
}

export function PlatformSelector({ selected, onSelect }: Props) {
  const { locale } = useLocale()
  const zh = locale === 'zh'

  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--foreground-muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        {zh ? '选择平台' : 'Select Platform'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PLATFORMS.map((p) => {
          const active = selected === p.key
          return (
            <button
              key={p.key}
              type="button"
              title={
                platformSupportsSync(p.key)
                  ? zh
                    ? '支持客户端同步'
                    : 'Client sync supported'
                  : zh
                    ? '可保存配置；客户端自动同步未接入（可导出）'
                    : 'Config savable; auto sync not wired (export instead)'
              }
              onClick={() => onSelect(p.key)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: active ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: active ? 'var(--primary-subtle)' : 'var(--card-bg)',
                color: active ? 'var(--primary)' : 'var(--foreground-secondary)',
                fontWeight: active ? 600 : 400,
                fontSize: 13,
                cursor: 'pointer',
                transition: 'all 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span>{p.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
