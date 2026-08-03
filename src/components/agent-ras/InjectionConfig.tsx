'use client';

import { useLocale } from '@/lib/client/locale-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FaultType } from './mockData';

interface Props {
  mode: 'single' | 'batch';
  onModeChange: (mode: 'single' | 'batch') => void;
  selectedFault: FaultType | null;
  selectedFaults: FaultType[];
  target: string;
  onTargetChange: (v: string) => void;
  params: Record<string, string>;
  onParamsChange: (p: Record<string, string>) => void;
  onInject: () => void;
}

export function InjectionConfig({
  mode,
  onModeChange,
  selectedFault,
  selectedFaults,
  target,
  onTargetChange,
  params,
  onParamsChange,
  onInject,
}: Props) {
  const { locale } = useLocale();

  const currentFault = mode === 'single' ? selectedFault : null;
  const allParams = currentFault
    ? currentFault.params
    : mode === 'batch'
      ? [...new Set(selectedFaults.flatMap(f => f.params.map(p => p.key)))]
        .map(key => {
          const first = selectedFaults.flatMap(f => f.params).find(p => p.key === key);
          return first || { key, label: key, type: 'text' as const, defaultValue: '' };
        })
      : [];

  return (
    <div style={{
      borderRadius: 8,
      border: '1px solid var(--border)',
      background: 'var(--card-bg)',
      padding: 16,
    }}>
      <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>
        {locale === 'zh' ? '注入配置' : 'Injection Config'}
      </h4>

      {/* Mode toggle */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--foreground-muted)', marginBottom: 6 }}>
          {locale === 'zh' ? '注入模式' : 'Mode'}
        </label>
        <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content' }}>
          <button
            onClick={() => onModeChange('single')}
            style={{
              padding: '5px 14px',
              border: 'none',
              background: mode === 'single' ? 'var(--primary)' : 'var(--card-bg)',
              color: mode === 'single' ? '#fff' : 'var(--foreground-secondary)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {locale === 'zh' ? '单条注入' : 'Single'}
          </button>
          <button
            onClick={() => onModeChange('batch')}
            style={{
              padding: '5px 14px',
              border: 'none',
              background: mode === 'batch' ? 'var(--primary)' : 'var(--card-bg)',
              color: mode === 'batch' ? '#fff' : 'var(--foreground-secondary)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {locale === 'zh' ? '批量注入' : 'Batch'}
          </button>
        </div>
      </div>

      {/* Selected faults summary */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--foreground-muted)', marginBottom: 6 }}>
          {locale === 'zh' ? '已选故障' : 'Selected Faults'}
        </label>
        {mode === 'single' && (
          selectedFault ? (
            <div style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--background-secondary)',
              fontSize: 12,
            }}>
              {locale === 'zh' ? selectedFault.label : selectedFault.name}
            </div>
          ) : (
            <div style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px dashed var(--border)',
              color: 'var(--foreground-muted)',
              fontSize: 12,
            }}>
              {locale === 'zh' ? '请从左侧目录选择故障类型' : 'Select a fault type from the catalog'}
            </div>
          )
        )}
        {mode === 'batch' && (
          selectedFaults.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {selectedFaults.map(f => (
                <span
                  key={f.id}
                  style={{
                    padding: '3px 8px',
                    borderRadius: 4,
                    border: '1px solid var(--border)',
                    fontSize: 11,
                    background: 'var(--background-secondary)',
                  }}
                >
                  {locale === 'zh' ? f.label : f.name}
                </span>
              ))}
            </div>
          ) : (
            <div style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px dashed var(--border)',
              color: 'var(--foreground-muted)',
              fontSize: 12,
            }}>
              {locale === 'zh' ? '请从左侧目录勾选多个故障' : 'Check multiple faults from the catalog'}
            </div>
          )
        )}
      </div>

      {/* Target */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--foreground-muted)', marginBottom: 6 }}>
          {locale === 'zh' ? '目标 Agent ID' : 'Target Agent ID'}
        </label>
        <Input
          value={target}
          onChange={e => onTargetChange(e.target.value)}
          placeholder={locale === 'zh' ? '如: deep-agent-v3' : 'e.g. deep-agent-v3'}
        />
      </div>

      {/* Parameters */}
      {allParams.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--foreground-muted)', marginBottom: 6 }}>
            {locale === 'zh' ? '注入参数' : 'Injection Parameters'}
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {allParams.map(p => (
              <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 11, color: 'var(--foreground-secondary)', minWidth: 80 }}>
                  {p.label || p.key}
                </label>
                <Input
                  value={params[p.key] || p.defaultValue || ''}
                  onChange={e =>
                    onParamsChange({ ...params, [p.key]: e.target.value })
                  }
                  placeholder={p.placeholder}
                  type={p.type === 'number' ? 'number' : 'text'}
                  style={{ flex: 1 }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <Button
        onClick={onInject}
        style={{ width: '100%' }}
        disabled={mode === 'single' ? !selectedFault : !selectedFaults.length}
      >
        {locale === 'zh'
          ? (mode === 'batch' ? `批量注入 (${selectedFaults.length})` : '注入故障')
          : (mode === 'batch' ? `Batch Inject (${selectedFaults.length})` : 'Inject Fault')}
      </Button>
    </div>
  );
}
