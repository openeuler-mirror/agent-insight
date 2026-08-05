'use client';

import { useEffect, useState } from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import { useLocale } from '@/lib/client/locale-context';
import {
  RAS_FAULT_MODE_CATALOG,
  type RasFaultModeCatalogItem,
  type RasFaultModeId,
  type RasFaultSeverity,
  type RasRecoveryPrompt,
  type RasRecoveryPromptRole,
} from '@/lib/ingest/ras/fault-mode-catalog';
import {
  loadFaultModeSubLabelOverrides,
  resetFaultModeSubLabel,
  resolveFaultModeSubLabel,
  saveFaultModeSubLabelOverrides,
  type FaultModeSubLabelOverrides,
} from '@/lib/ingest/ras/fault-mode-label-store';
import { rasSeverityLabel, severityToStatusKind } from '@/lib/ingest/ras/normalize';
import { StatusBadge } from '@/components/feedback/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const PROMPT_ROLE_LABEL: Record<RasRecoveryPromptRole, { zh: string; en: string }> = {
  steering: { zh: '注入 steering', en: 'Inject steering' },
  notice: { zh: '用户通知', en: 'User notice' },
  critical: { zh: '严重提示', en: 'Critical notice' },
};

function promptTemplate(prompt: RasRecoveryPrompt, locale: 'zh' | 'en'): string {
  return locale === 'zh' ? prompt.templateZh : prompt.templateEn;
}

function SeverityCell({ severities, locale }: { severities: RasFaultSeverity[]; locale: 'zh' | 'en' }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {severities.map((s) => (
        <StatusBadge
          key={s}
          status={severityToStatusKind(s)}
          label={rasSeverityLabel(s, locale)}
          size="sm"
        />
      ))}
    </div>
  );
}

function SubModeCell({
  item,
  locale,
  overrides,
  onSave,
  onReset,
}: {
  item: RasFaultModeCatalogItem;
  locale: 'zh' | 'en';
  overrides: FaultModeSubLabelOverrides;
  onSave: (id: RasFaultModeId, value: string) => void;
  onReset: (id: RasFaultModeId) => void;
}) {
  const display = resolveFaultModeSubLabel(item.id, locale, overrides);
  const isOverridden = Boolean(overrides[item.id]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);

  useEffect(() => {
    if (!editing) setDraft(display);
  }, [display, editing]);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === item.subMode[locale]) {
      onReset(item.id);
    } else {
      onSave(item.id, next);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(display);
              setEditing(false);
            }
          }}
          className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={locale === 'zh' ? '编辑子故障模式名称' : 'Edit sub-mode name'}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 min-w-0 group">
      <span className="truncate text-foreground" title={display}>{display}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          setDraft(display);
          setEditing(true);
        }}
        aria-label={locale === 'zh' ? '编辑' : 'Edit'}
      >
        <Pencil className="size-3.5" />
      </Button>
      {isOverridden && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onReset(item.id)}
          aria-label={locale === 'zh' ? '恢复默认' : 'Reset to default'}
          title={locale === 'zh' ? '恢复默认' : 'Reset to default'}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function promptActionLabel(prompt: RasRecoveryPrompt, locale: 'zh' | 'en'): string {
  if (prompt.label) return prompt.label[locale];
  const roleLabel = PROMPT_ROLE_LABEL[prompt.role][locale];
  const band = prompt.severityBand
    ? rasSeverityLabel(prompt.severityBand, locale)
    : null;
  return band ? `${roleLabel} (${band})` : roleLabel;
}

function RecoveryCell({
  item,
  locale,
  onOpenPrompt,
}: {
  item: RasFaultModeCatalogItem;
  locale: 'zh' | 'en';
  onOpenPrompt: (item: RasFaultModeCatalogItem, prompt: RasRecoveryPrompt) => void;
}) {
  const summary = item.recoverySummary[locale];
  return (
    <div className="space-y-1.5 min-w-0">
      <p className="text-sm text-foreground-secondary leading-snug">{summary}</p>
      {item.prompts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.prompts.map((prompt) => (
            <button
              key={`${prompt.key}-${prompt.severityBand || 'default'}`}
              type="button"
              className="inline-flex items-center rounded-md border border-border bg-background-secondary px-2 py-0.5 text-xs font-medium text-foreground-secondary transition-colors hover:border-foreground-muted hover:bg-background hover:text-foreground"
              onClick={() => onOpenPrompt(item, prompt)}
            >
              {promptActionLabel(prompt, locale)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RasFaultModeTable() {
  const { locale } = useLocale();
  const [overrides, setOverrides] = useState<FaultModeSubLabelOverrides>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<RasFaultModeCatalogItem | null>(null);
  const [activePrompt, setActivePrompt] = useState<RasRecoveryPrompt | null>(null);

  useEffect(() => {
    setOverrides(loadFaultModeSubLabelOverrides());
  }, []);

  const handleSave = (id: RasFaultModeId, value: string) => {
    const next = { ...overrides, [id]: value };
    saveFaultModeSubLabelOverrides(next);
    setOverrides(next);
  };

  const handleReset = (id: RasFaultModeId) => {
    setOverrides(resetFaultModeSubLabel(id, overrides));
  };

  const openPrompt = (item: RasFaultModeCatalogItem, prompt: RasRecoveryPrompt) => {
    setActiveItem(item);
    setActivePrompt(prompt);
    setDialogOpen(true);
  };

  return (
    <>
      <div className="rounded-md border border-card-border bg-card overflow-auto">
        <table className="w-full min-w-[960px] table-fixed text-sm">
          <colgroup>
            <col style={{ width: 140 }} />
            <col style={{ width: 200 }} />
            <col />
            <col style={{ width: 160 }} />
          </colgroup>
          <thead className="sticky top-0 z-[1] bg-background-secondary">
            <tr className="border-b border-card-border text-left text-foreground-muted">
              <th className="px-3 py-2.5 font-medium">
                {locale === 'zh' ? '故障模式' : 'Fault mode'}
              </th>
              <th className="px-3 py-2.5 font-medium">
                {locale === 'zh' ? '子故障模式' : 'Sub-mode'}
              </th>
              <th className="px-3 py-2.5 font-medium">
                {locale === 'zh' ? '恢复措施' : 'Recovery'}
              </th>
              <th className="px-3 py-2.5 font-medium">
                {locale === 'zh' ? '严重度' : 'Severity'}
              </th>
            </tr>
          </thead>
          <tbody>
            {RAS_FAULT_MODE_CATALOG.map((item) => (
              <tr key={item.id} className="border-b border-card-border last:border-b-0 align-top hover:bg-background-secondary/60">
                <td className="px-3 py-3 text-foreground">
                  <div className="font-medium">{item.parent[locale]}</div>
                  {item.detectionLevel && (
                    <div className="mt-0.5 text-xs text-foreground-muted tabular-nums">
                      {item.detectionLevel}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3">
                  <SubModeCell
                    item={item}
                    locale={locale}
                    overrides={overrides}
                    onSave={handleSave}
                    onReset={handleReset}
                  />
                  <p className="mt-1 text-xs text-foreground-muted leading-snug">
                    {item.detects[locale]}
                  </p>
                </td>
                <td className="px-3 py-3">
                  <RecoveryCell item={item} locale={locale} onOpenPrompt={openPrompt} />
                </td>
                <td className="px-3 py-3">
                  <SeverityCell severities={item.severities} locale={locale} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-[720px] max-h-[88vh] flex flex-col p-0 gap-0">
          <DialogHeader className="flex-row items-center gap-3 p-4 border-b border-border space-y-0">
            <DialogTitle className="text-sm font-semibold text-foreground">
              {activePrompt
                ? promptActionLabel(activePrompt, locale)
                : (locale === 'zh' ? '恢复提示词' : 'Recovery prompt')}
              {activeItem && (
                <span className="ml-2 font-normal text-foreground-muted">
                  · {resolveFaultModeSubLabel(activeItem.id, locale, overrides)}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="p-4 overflow-auto">
            {activePrompt && (
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background-secondary p-3 text-sm text-foreground leading-relaxed font-sans">
                {promptTemplate(activePrompt, locale)}
              </pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
