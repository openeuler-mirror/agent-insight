'use client';

import { useLocale } from '@/lib/client/locale-context';
import { EmptyState } from '@/components/feedback/EmptyState';
import type { InjectionRecord } from './mockData';

const STATUS_CONFIG: Record<string, { label_zh: string; label_en: string; bg: string; fg: string }> = {
  pending: { label_zh: '等待中', label_en: 'Pending', bg: 'var(--tag-amber-bg)', fg: 'var(--tag-amber-fg)' },
  running: { label_zh: '运行中', label_en: 'Running', bg: 'var(--tag-blue-bg)', fg: 'var(--tag-blue-fg)' },
  completed: { label_zh: '已完成', label_en: 'Completed', bg: 'var(--tag-green-bg)', fg: 'var(--tag-green-fg)' },
  failed: { label_zh: '失败', label_en: 'Failed', bg: 'var(--tag-red-bg)', fg: 'var(--tag-red-fg)' },
};

interface Props {
  records: InjectionRecord[];
}

export function InjectionHistory({ records }: Props) {
  const { locale } = useLocale();

  if (!records.length) {
    return (
      <EmptyState
        title={locale === 'zh' ? '暂无注入记录' : 'No injection records'}
        description={locale === 'zh' ? '提交注入任务后此处会显示历史记录' : 'Injection history will appear here'}
      />
    );
  }

  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--border)',
      background: 'var(--card-bg)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--foreground-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        {locale === 'zh' ? '注入历史' : 'Injection History'}
        <span style={{ marginLeft: 8, fontWeight: 400 }}>
          ({records.length})
        </span>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '80px 140px 120px 120px 100px 160px 1fr',
        gap: 12,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--background-secondary)',
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--foreground-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        <span>ID</span>
        <span>{locale === 'zh' ? '故障类型' : 'Fault Type'}</span>
        <span>{locale === 'zh' ? '平台' : 'Platform'}</span>
        <span>{locale === 'zh' ? '目标' : 'Target'}</span>
        <span>{locale === 'zh' ? '状态' : 'Status'}</span>
        <span>{locale === 'zh' ? '时间' : 'Time'}</span>
        <span>{locale === 'zh' ? '参数' : 'Params'}</span>
      </div>

      {records.map(rec => {
        const st = STATUS_CONFIG[rec.status] || STATUS_CONFIG.pending;
        return (
          <div
            key={rec.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '80px 140px 120px 120px 100px 160px 1fr',
              gap: 12,
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              fontSize: 12,
              alignItems: 'center',
            }}
          >
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--foreground-muted)' }}>
              {rec.id.slice(-8)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--foreground-secondary)' }}>
              {rec.faultType}
            </span>
            <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
              {rec.platform}
            </span>
            <span style={{ fontSize: 11, color: 'var(--foreground-muted)' }}>
              {rec.target}
            </span>
            <span
              style={{
                display: 'inline-block',
                padding: '1px 8px',
                borderRadius: 10,
                fontSize: 10,
                fontWeight: 500,
                background: st.bg,
                color: st.fg,
                width: 'fit-content',
              }}
            >
              {locale === 'zh' ? st.label_zh : st.label_en}
            </span>
            <span style={{ fontSize: 10, color: 'var(--foreground-muted)' }}>
              {new Date(rec.createdAt).toLocaleString()}
            </span>
            <span style={{ fontSize: 10, color: 'var(--foreground-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {Object.entries(rec.params).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
