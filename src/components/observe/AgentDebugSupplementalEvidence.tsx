'use client';

import type { AgentDebugSupplementalEvidence } from '@/lib/engine/agent-debug/types';

export function AgentDebugSupplementalEvidenceBlock({ evidence, zh, onNodeRefClick }: {
  evidence: AgentDebugSupplementalEvidence;
  zh: boolean;
  onNodeRefClick?: (nodeId: string) => void;
}) {
  return (
    <div className="mb-2 space-y-2 rounded-md border border-border bg-background-secondary p-2.5">
      {evidence.summary && (
        <section>
          <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '补充结论' : 'Additional conclusion'}</div>
          <p className="text-[12px] leading-5 text-foreground-muted">{evidence.summary}</p>
        </section>
      )}
      {evidence.facts.length > 0 && (
        <section>
          <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '诊断事实' : 'Diagnostic facts'}</div>
          <ul className="space-y-0.5">
            {evidence.facts.map((fact, index) => (
              <li key={index} className="text-[12px] leading-5 text-foreground-muted">• {fact}</li>
            ))}
          </ul>
        </section>
      )}
      {evidence.mechanism && (
        <section>
          <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '故障机制' : 'Mechanism'}</div>
          <p className="text-[12px] leading-5 text-foreground-muted">{evidence.mechanism}</p>
        </section>
      )}
      {evidence.faultChain.length > 0 && (
        <section>
          <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '故障链' : 'Fault chain'}</div>
          <ol className="space-y-0.5">
            {evidence.faultChain.map((step, index) => (
              <li key={index} className="text-[12px] leading-5 text-foreground-muted">{index + 1}. {step}</li>
            ))}
          </ol>
        </section>
      )}
      {evidence.correctionGuidance && (
        <section>
          <div className="mb-1 text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '补充建议' : 'Additional guidance'}</div>
          <p className="text-[12px] leading-5 text-foreground-muted">{evidence.correctionGuidance}</p>
        </section>
      )}
      {evidence.anchors.length > 0 && (
        <section className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] font-bold tracking-wider text-foreground-muted">{zh ? '证据节点' : 'Evidence'}</span>
          {evidence.anchors.map((anchor, index) => {
            const label = anchor.traceStepIndex != null ? `#${anchor.traceStepIndex}` : (anchor.traceNodeLabel || `node ${index + 1}`);
            const clickable = Boolean(anchor.anchorId && onNodeRefClick);
            return (
              <button
                key={index}
                type="button"
                disabled={!clickable}
                onClick={() => { if (anchor.anchorId && onNodeRefClick) onNodeRefClick(anchor.anchorId); }}
                className={`rounded border border-border px-1.5 py-0.5 text-[11px] ${clickable ? 'cursor-pointer text-error hover:bg-error-subtle' : 'cursor-default text-foreground-muted'}`}
                title={anchor.traceNodeLabel || ''}
              >
                {label}{anchor.note ? ` · ${anchor.note}` : ''}
              </button>
            );
          })}
        </section>
      )}
    </div>
  );
}
