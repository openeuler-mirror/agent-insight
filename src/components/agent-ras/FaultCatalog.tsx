'use client';

import { useState } from 'react';
import { useLocale } from '@/lib/client/locale-context';
import type { FaultType } from './mockData';

const CATEGORY_LABELS: Record<string, { zh: string; en: string }> = {
  thinking: { zh: '思考类', en: 'Thinking' },
  tool: { zh: '工具类', en: 'Tool' },
  communication: { zh: '通信类', en: 'Communication' },
  resource: { zh: '资源类', en: 'Resource' },
};

const SEVERITY_DOT: Record<string, string> = {
  critical: 'var(--color-red)',
  warning: 'var(--color-amber)',
  info: 'var(--foreground-muted)',
};

interface Props {
  faults: FaultType[];
  selectedFault: FaultType | null;
  selectedFaults: FaultType[];
  mode: 'single' | 'batch';
  onSelectFault: (f: FaultType) => void;
}

export function FaultCatalog({ faults, selectedFault, selectedFaults, mode, onSelectFault }: Props) {
  const { locale } = useLocale();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const grouped = faults.reduce<Record<string, FaultType[]>>((acc, f) => {
    if (!acc[f.category]) acc[f.category] = [];
    acc[f.category].push(f);
    return acc;
  }, {});

  const toggleCategory = (cat: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const isSelected = (f: FaultType) =>
    mode === 'single' ? selectedFault?.id === f.id : selectedFaults.some(s => s.id === f.id);

  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--border)',
      background: 'var(--card-bg)',
      overflow: 'hidden',
      height: 'fit-content',
      maxHeight: 'calc(100vh - 200px)',
      overflowY: 'auto',
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
        {locale === 'zh' ? '故障类型目录' : 'Fault Catalog'}
      </div>

      {Object.entries(grouped).map(([cat, items]) => {
        const catLabel = (CATEGORY_LABELS[cat] || { zh: cat, en: cat })[locale === 'zh' ? 'zh' : 'en'];
        const isCollapsed = collapsed.has(cat);

        return (
          <div key={cat}>
            <button
              onClick={() => toggleCategory(cat)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '6px 12px',
                border: 'none',
                borderBottom: isCollapsed ? '1px solid var(--border)' : 'none',
                background: 'var(--background-secondary)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--foreground-secondary)',
              }}
            >
              <svg
                width="10" height="10" viewBox="0 0 10 10"
                fill="none" stroke="currentColor" strokeWidth="1.5"
                style={{
                  transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s',
                }}
              >
                <path d="M2 3l3 3 3-3" />
              </svg>
              <span>{catLabel}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--foreground-muted)' }}>
                {items.length}
              </span>
            </button>

            {!isCollapsed && items.map(f => {
              const sel = isSelected(f);
              return (
                <button
                  key={f.id}
                  onClick={() => onSelectFault(f)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '8px 12px 8px 20px',
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    background: sel ? 'var(--primary-subtle)' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => {
                    if (!sel) (e.currentTarget as HTMLElement).style.background = 'var(--sidebar-hover)';
                  }}
                  onMouseLeave={e => {
                    if (!sel) (e.currentTarget as HTMLElement).style.background = 'transparent';
                  }}
                >
                  <span style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: SEVERITY_DOT[f.severity] || 'var(--foreground-muted)',
                    flexShrink: 0,
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: sel ? 600 : 400, color: 'var(--foreground)' }}>
                      {locale === 'zh' ? f.label : f.name}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--foreground-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
