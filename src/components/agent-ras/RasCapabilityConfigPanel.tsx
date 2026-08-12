'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { PlatformSelector } from '@/components/agent-ras/PlatformSelector';
import { RelativeTime } from '@/components/text/RelativeTime';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';
import type {
  RasCatalogDomain,
  RasCapabilityCatalog,
} from '@/lib/ingest/ras/catalog-engine';
import {
  defaultCapabilityConfigBody,
  platformSupportsSync,
  type RasCapabilityConfigBody,
  type RasCapabilityConfigEnvelope,
  type RasCapabilityPlatformId,
} from '@/lib/ingest/ras/capability-config';
import { setAnomalyKindLabelOverrides } from '@/lib/ingest/ras/normalize';

interface Props {
  focusDetector?: string | null;
}

function cloneConfig(config: RasCapabilityConfigBody): RasCapabilityConfigBody {
  return JSON.parse(JSON.stringify(config));
}

function domainSortKey(domain: RasCatalogDomain): number {
  return Number(domain.priority ?? domain.order ?? 0);
}

function schemaPropertyType(
  schema: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  const prop = props?.[key];
  if (!prop) return null;
  const t = prop.type;
  return typeof t === 'string' ? t : null;
}

function schemaPropertyMin(
  schema: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const props = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  const prop = props?.[key];
  if (!prop || typeof prop.minimum !== 'number') return undefined;
  return prop.minimum;
}

function fieldKeysForDomain(domain: RasCatalogDomain): string[] {
  const props = (domain.configSchema?.properties || {}) as Record<string, unknown>;
  const fromSchema = Object.keys(props);
  if (fromSchema.length > 0) return fromSchema;
  return Object.keys(domain.configDefaults || {});
}

function NumberField({
  label,
  value,
  onChange,
  min,
  step,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min?: number
  step?: number
}) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] font-medium text-foreground-muted">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 rounded-[var(--radius-md)] border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      />
    </label>
  );
}

function updateDetectorField(
  config: RasCapabilityConfigBody,
  domainId: string,
  field: string,
  value: unknown,
): RasCapabilityConfigBody {
  const prev = (config.detectors[domainId] || {}) as Record<string, unknown>;
  return {
    ...config,
    detectors: {
      ...config.detectors,
      [domainId]: { ...prev, [field]: value },
    },
  };
}

export function RasCapabilityConfigPanel({ focusDetector = null }: Props) {
  const { locale } = useLocale();
  const { apiKey } = useAuth();
  const zh = locale === 'zh';

  const [platform, setPlatform] = useState<RasCapabilityPlatformId>('opencode');
  const [envelope, setEnvelope] = useState<RasCapabilityConfigEnvelope | null>(null);
  const [draftConfig, setDraftConfig] = useState<RasCapabilityConfigBody>(defaultCapabilityConfigBody());
  const [draftSync, setDraftSync] = useState(false);
  const [domains, setDomains] = useState<RasCatalogDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (focusDetector) {
      setExpanded((prev) => ({ ...prev, [focusDetector]: true }));
      requestAnimationFrame(() => {
        document.getElementById(`detector-${focusDetector}`)?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      });
    }
  }, [focusDetector]);

  const load = useCallback(async (plat: string) => {
    if (!apiKey) {
      setError(zh ? '当前登录缺少 API Key' : 'Missing API key');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const headers = { 'x-witty-api-key': apiKey };
      const [catalogRes, configRes] = await Promise.all([
        apiFetch('/api/agent-ras/catalog', { headers }),
        apiFetch(`/api/agent-ras/config?platform=${encodeURIComponent(plat)}`, { headers }),
      ]);
      if (!catalogRes.ok) {
        const text = await catalogRes.text().catch(() => '');
        throw new Error(`catalog HTTP ${catalogRes.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
      }
      if (!configRes.ok) {
        const text = await configRes.text().catch(() => '');
        throw new Error(`config HTTP ${configRes.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
      }
      const catalogData = await catalogRes.json();
      const catalog = catalogData.catalog as RasCapabilityCatalog;
      if (catalog.kindLabels) {
        setAnomalyKindLabelOverrides(catalog.kindLabels);
      }
      const sorted = [...(catalog.domains || [])].sort(
        (a, b) => domainSortKey(a) - domainSortKey(b),
      );
      setDomains(sorted);

      const data = await configRes.json();
      const env = data.envelope as RasCapabilityConfigEnvelope;
      setEnvelope(env);
      setDraftConfig(cloneConfig(env.config));
      setDraftSync(Boolean(env.syncEnabled));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiKey, zh]);

  useEffect(() => {
    void load(platform);
  }, [load, platform]);

  const dirty = useMemo(() => {
    if (!envelope) return false;
    return (
      draftSync !== envelope.syncEnabled ||
      JSON.stringify(draftConfig) !== JSON.stringify(envelope.config)
    );
  }, [draftConfig, draftSync, envelope]);

  const syncSupported = platformSupportsSync(platform as RasCapabilityPlatformId);

  const save = async () => {
    if (!apiKey) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/agent-ras/config?platform=${encodeURIComponent(platform)}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-witty-api-key': apiKey,
        },
        body: JSON.stringify({
          syncEnabled: draftSync,
          config: draftConfig,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const env = data.envelope as RasCapabilityConfigEnvelope;
      setEnvelope(env);
      setDraftConfig(cloneConfig(env.config));
      setDraftSync(Boolean(env.syncEnabled));
      toast.success(zh ? '已保存' : 'Saved');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!envelope) return;
    setDraftConfig(cloneConfig(envelope.config));
    setDraftSync(Boolean(envelope.syncEnabled));
  };

  const copyExport = async (format: 'yaml' | 'json-export') => {
    if (!apiKey) return;
    try {
      const res = await apiFetch(
        `/api/agent-ras/config?platform=${encodeURIComponent(platform)}&format=${format}`,
        { headers: { 'x-witty-api-key': apiKey } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      toast.success(zh ? '已复制到剪贴板' : 'Copied to clipboard');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const domainTitle = (domain: RasCatalogDomain) => {
    if (domain.label) {
      return (zh ? domain.label.zh : domain.label.en) || domain.id;
    }
    return domain.id;
  };

  const domainSummary = (domain: RasCatalogDomain) => {
    const kinds = domain.kinds || [];
    if (kinds.length === 0) return domain.id;
    return kinds.join(' · ');
  };

  return (
    <div className="flex flex-col gap-4">
      <PlatformSelector
        selected={platform}
        onSelect={(p) => {
          if (dirty && !window.confirm(zh ? '有未保存更改，切换平台将丢弃？' : 'Discard unsaved changes?')) {
            return;
          }
          setPlatform(p);
        }}
      />

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--error)]/30 bg-[var(--error-subtle)] px-3 py-2 text-sm text-[var(--error)]">
          {error}
        </div>
      )}

      {loading && !envelope ? (
        <div className="flex items-center gap-2 text-sm text-foreground-muted py-8 justify-center">
          <Loader2 className="size-4 animate-spin" />
          {zh ? '加载配置…' : 'Loading config…'}
        </div>
      ) : (
        <>
          <div className="rounded-[var(--radius-lg)] border border-border bg-card-bg px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center justify-between gap-4 sm:justify-start">
              <div>
                <div className="text-sm font-semibold text-foreground">
                  {zh ? '启用 Agent RAS' : 'Enable Agent RAS'}
                </div>
                <div className="text-xs text-foreground-muted mt-0.5">
                  {zh ? '总开关；关闭后不挂载检测与恢复' : 'Master switch; disables detection and recovery'}
                </div>
              </div>
              <Switch
                checked={draftConfig.enabled}
                onCheckedChange={(v) => setDraftConfig((c) => ({ ...c, enabled: v }))}
              />
            </div>
            <div className="flex items-center justify-between gap-4 sm:justify-start border-t border-border pt-3 sm:border-t-0 sm:pt-0 sm:border-l sm:pl-4">
              <div>
                <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                  {zh ? '同步到客户端' : 'Sync to client'}
                  {!syncSupported && (
                    <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--tag-amber-bg)] text-[var(--tag-amber-fg)]">
                      {zh ? '本期不可用' : 'N/A'}
                    </span>
                  )}
                  {syncSupported && draftSync && (
                    <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--primary-subtle)] text-primary">
                      {zh ? '将下发' : 'Will push'}
                    </span>
                  )}
                </div>
                <div className="text-xs text-foreground-muted mt-0.5">
                  {syncSupported
                    ? (zh
                      ? (platform === 'xiaoo'
                        ? '开启后 xiaoO hooker 启动会话时拉取本配置'
                        : '开启后 OpenCode 启动时拉取本配置')
                      : (platform === 'xiaoo'
                        ? 'xiaoO hooker pulls this config when a session starts'
                        : 'OpenCode pulls this config on startup'))
                    : (zh ? '该平台请导出后人工落盘' : 'Export and apply manually for this platform')}
                </div>
              </div>
              <Switch
                checked={draftSync && syncSupported}
                disabled={!syncSupported}
                onCheckedChange={(v) => setDraftSync(v)}
              />
            </div>
          </div>

          {domains.map((domain) => {
            const key = domain.id;
            const det = (draftConfig.detectors[key] || domain.configDefaults || {}) as Record<string, unknown>;
            const open = Boolean(expanded[key]) || focusDetector === key;
            const enabled = Boolean(det.enabled);
            const fieldKeys = fieldKeysForDomain(domain).filter((f) => f !== 'enabled');
            return (
              <div
                key={key}
                id={`detector-${key}`}
                className={`rounded-[var(--radius-lg)] border bg-card-bg ${
                  focusDetector === key ? 'border-primary' : 'border-border'
                }`}
              >
                <div className="px-4 py-3 flex items-center gap-3">
                  <button
                    type="button"
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    onClick={() => setExpanded((e) => ({ ...e, [key]: !open }))}
                  >
                    {open ? (
                      <ChevronDown className="size-4 shrink-0 text-foreground-muted" />
                    ) : (
                      <ChevronRight className="size-4 shrink-0 text-foreground-muted" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{domainTitle(domain)}</div>
                      <div className="text-xs text-foreground-muted truncate">{domainSummary(domain)}</div>
                    </div>
                  </button>
                  <Switch
                    checked={enabled}
                    disabled={!draftConfig.enabled}
                    onCheckedChange={(v) =>
                      setDraftConfig((c) => updateDetectorField(c, key, 'enabled', v))
                    }
                  />
                </div>
                {open && (
                  <div className="px-4 pb-4 border-t border-border pt-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted mb-2">
                      {zh ? '高级阈值' : 'Advanced thresholds'}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {fieldKeys.map((field) => {
                        const type =
                          schemaPropertyType(domain.configSchema, field)
                          ?? (typeof det[field] === 'boolean'
                            ? 'boolean'
                            : typeof det[field] === 'number'
                              ? 'number'
                              : typeof (domain.configDefaults || {})[field] === 'boolean'
                                ? 'boolean'
                                : typeof (domain.configDefaults || {})[field] === 'number'
                                  ? 'number'
                                  : null);
                        if (type === 'boolean') {
                          return (
                            <div
                              key={field}
                              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-border px-3 py-2"
                            >
                              <span className="text-xs text-foreground-secondary">{field}</span>
                              <Switch
                                checked={Boolean(det[field])}
                                onCheckedChange={(v) =>
                                  setDraftConfig((c) => updateDetectorField(c, key, field, v))
                                }
                              />
                            </div>
                          );
                        }
                        if (type === 'number' || type === 'integer') {
                          const raw = det[field] ?? (domain.configDefaults || {})[field] ?? 0;
                          const value = typeof raw === 'number' ? raw : Number(raw) || 0;
                          const min = schemaPropertyMin(domain.configSchema, field);
                          return (
                            <NumberField
                              key={field}
                              label={field}
                              value={value}
                              min={min}
                              step={type === 'number' && !Number.isInteger(min ?? value) ? 0.01 : undefined}
                              onChange={(n) =>
                                setDraftConfig((c) => updateDetectorField(c, key, field, n))
                              }
                            />
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div className="rounded-[var(--radius-lg)] border border-border bg-card-bg px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-foreground">
                {zh ? 'LOW 警告通知用户' : 'Notify user on LOW warning'}
              </div>
              <div className="text-xs text-foreground-muted mt-0.5">
                recovery.notify_user_on_warning
              </div>
            </div>
            <Switch
              checked={draftConfig.recovery.notify_user_on_warning}
              disabled={!draftConfig.enabled}
              onCheckedChange={(v) =>
                setDraftConfig((c) => ({
                  ...c,
                  recovery: { notify_user_on_warning: v },
                }))
              }
            />
          </div>

          <div className="sticky bottom-0 z-10 -mx-1 px-1 py-3 bg-background/95 backdrop-blur border-t border-border flex flex-wrap items-center gap-2 justify-between">
            <div className="text-xs text-foreground-muted font-mono flex flex-wrap items-center gap-1">
              {envelope ? (
                <>
                  <span>{`rev ${envelope.revision} ·`}</span>
                  <RelativeTime value={envelope.updatedAt} display="absolute" className="text-xs text-foreground-muted font-mono" />
                </>
              ) : (
                '—'
              )}
              {dirty && (
                <span className="ml-2 text-[var(--warning)] font-sans font-medium">
                  {zh ? '未保存' : 'Unsaved'}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void copyExport('yaml')}>
                <Copy className="size-3.5" />
                YAML
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyExport('json-export')}>
                <Copy className="size-3.5" />
                JSON
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}>
                {zh ? '丢弃' : 'Discard'}
              </Button>
              <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {zh ? '保存' : 'Save'}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
