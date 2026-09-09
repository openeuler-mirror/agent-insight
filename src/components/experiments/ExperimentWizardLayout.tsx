'use client';

import type { CSSProperties, ReactNode } from 'react';

export const experimentPanelStyle: CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--card-border)',
  borderRadius: 12, marginBottom: 14, overflow: 'hidden',
};
export const experimentPanelBodyStyle: CSSProperties = { padding: '13px 15px' };
export const experimentFieldLabelStyle: CSSProperties = {
  display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--foreground-muted)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 7,
};
export const experimentInputStyle: CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', fontSize: 13, borderRadius: 8,
  border: '1px solid var(--input-border)', background: 'var(--input-bg)',
  color: 'var(--foreground)', outline: 'none',
};
export const experimentButtonStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  height: 30, padding: '0 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
  cursor: 'pointer', border: '1px solid transparent', whiteSpace: 'nowrap',
};
export const experimentPrimaryButtonStyle: CSSProperties = {
  ...experimentButtonStyle, background: 'var(--primary)', color: 'var(--primary-foreground)',
};
export const experimentGhostButtonStyle: CSSProperties = {
  ...experimentButtonStyle, background: 'none', color: 'var(--foreground-secondary)', border: 'none',
};

export function ExperimentWizardPanel({ children }: { children: ReactNode }) {
  return <section style={experimentPanelStyle}><div style={experimentPanelBodyStyle}>{children}</div></section>;
}

export function ExperimentWizardHeading({ onBack, description, actions }: {
  onBack: () => void; description?: ReactNode; actions?: ReactNode;
}) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0 12px' }}>
    <button type="button" style={{ ...experimentGhostButtonStyle, height: 26, padding: '0 9px', fontSize: 11.5 }} onClick={onBack}>‹ 返回</button>
    <div><h1 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.02em', margin: 0 }}>新建实验</h1>
      {description && <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--foreground-muted)' }}>{description}</p>}
    </div>
    <span style={{ flex: 1 }} />{actions}
  </div>;
}

export function ExperimentWizardFooter({ step, onBack, onNext, nextLabel, nextDisabled, busy = false }: {
  step: number; onBack: () => void; onNext: () => void; nextLabel: string; nextDisabled?: boolean; busy?: boolean;
}) {
  return <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
    {step > 1 && <button type="button" style={experimentGhostButtonStyle} disabled={busy} onClick={onBack}>← 上一步</button>}
    <button type="button" disabled={nextDisabled || busy} onClick={onNext} style={{ ...experimentPrimaryButtonStyle, opacity: nextDisabled || busy ? 0.5 : 1, cursor: nextDisabled || busy ? 'not-allowed' : 'pointer' }}>{nextLabel}</button>
  </div>;
}

export function ExperimentAssetFields({ object, version }: { object: ReactNode; version: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(80px,120px)] gap-3">{object}{version}</div>;
}
