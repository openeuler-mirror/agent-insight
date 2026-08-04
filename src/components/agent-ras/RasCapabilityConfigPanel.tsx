'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { PlatformSelector } from '@/components/agent-ras/PlatformSelector';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/lib/auth/auth-context';
import { apiFetch } from '@/lib/client/api';
import { useLocale } from '@/lib/client/locale-context';
import {
  defaultCapabilityConfigBody,
  platformSupportsSync,
  type RasCapabilityConfigBody,
  type RasCapabilityConfigEnvelope,
  type RasCapabilityPlatformId,
} from '@/lib/ingest/ras/capability-config';

type DetectorKey = 'llm_thinking_loop' | 'repeat_tool';

interface Props {
  focusDetector?: DetectorKey | null;
}

function cloneConfig(config: RasCapabilityConfigBody): RasCapabilityConfigBody {
  return JSON.parse(JSON.stringify(config));
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

export function RasCapabilityConfigPanel({ focusDetector = null }: Props) {
  const { locale } = useLocale();
  const { apiKey } = useAuth();
  const zh = locale === 'zh';

  const [platform, setPlatform] = useState<string>('opencode');
  const [envelope, setEnvelope] = useState<RasCapabilityConfigEnvelope | null>(null);
  const [draftConfig, setDraftConfig] = useState<RasCapabilityConfigBody>(defaultCapabilityConfigBody());
  const [draftSync, setDraftSync] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<DetectorKey, boolean>>({
    llm_thinking_loop: false,
    repeat_tool: false,
  });

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
      const res = await apiFetch(`/api/agent-ras/config?platform=${encodeURIComponent(plat)}`, {
        headers: { 'x-witty-api-key': apiKey },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
      }
      const data = await res.json();
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

  const detectorMeta: Record<DetectorKey, { title: string; summary: string }> = {
    llm_thinking_loop: {
      title: zh ? '思考 / 文本循环' : 'Thinking / text loop',
      summary: zh
        ? 'L1 字面周期 · L2 相似分句 · 可选 L3 语义 Judge'
        : 'L1 suffix cycle · L2 similar clauses · optional L3 semantic judge',
    },
    repeat_tool: {
      title: zh ? '工具调用重复' : 'Repeat tool calls',
      summary: zh
        ? '同参重复 · ping-pong · 未知工具 · 全局熔断'
        : 'Generic repeat · ping-pong · unknown tool · global breaker',
    },
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
                    ? (zh ? '开启后 OpenCode 启动时拉取本配置' : 'OpenCode pulls this config on startup')
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

          {(Object.keys(detectorMeta) as DetectorKey[]).map((key) => {
            const meta = detectorMeta[key]
            const det = draftConfig.detectors[key]
            const open = expanded[key] || focusDetector === key
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
                      <div className="text-sm font-semibold text-foreground">{meta.title}</div>
                      <div className="text-xs text-foreground-muted truncate">{meta.summary}</div>
                    </div>
                  </button>
                  <Switch
                    checked={det.enabled}
                    disabled={!draftConfig.enabled}
                    onCheckedChange={(v) =>
                      setDraftConfig((c) => ({
                        ...c,
                        detectors: {
                          ...c.detectors,
                          [key]: { ...c.detectors[key], enabled: v },
                        },
                      }))
                    }
                  />
                </div>
                {open && (
                  <div className="px-4 pb-4 border-t border-border pt-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted mb-2">
                      {zh ? '高级阈值' : 'Advanced thresholds'}
                    </div>
                    {key === 'llm_thinking_loop' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        <NumberField
                          label="detection_start_chars"
                          value={draftConfig.detectors.llm_thinking_loop.detection_start_chars}
                          min={1}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                llm_thinking_loop: {
                                  ...c.detectors.llm_thinking_loop,
                                  detection_start_chars: n,
                                },
                              },
                            }))
                          }
                        />
                        <NumberField
                          label="window_max_chars"
                          value={draftConfig.detectors.llm_thinking_loop.window_max_chars}
                          min={100}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                llm_thinking_loop: {
                                  ...c.detectors.llm_thinking_loop,
                                  window_max_chars: n,
                                },
                              },
                            }))
                          }
                        />
                        <NumberField
                          label="loop_repeat_threshold"
                          value={draftConfig.detectors.llm_thinking_loop.loop_repeat_threshold}
                          min={2}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                llm_thinking_loop: {
                                  ...c.detectors.llm_thinking_loop,
                                  loop_repeat_threshold: n,
                                },
                              },
                            }))
                          }
                        />
                        <NumberField
                          label="similar_clause_sim_threshold"
                          value={draftConfig.detectors.llm_thinking_loop.similar_clause_sim_threshold}
                          min={0}
                          step={0.01}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                llm_thinking_loop: {
                                  ...c.detectors.llm_thinking_loop,
                                  similar_clause_sim_threshold: n,
                                },
                              },
                            }))
                          }
                        />
                        <NumberField
                          label="semantic_eval_chars"
                          value={draftConfig.detectors.llm_thinking_loop.semantic_eval_chars}
                          min={1}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                llm_thinking_loop: {
                                  ...c.detectors.llm_thinking_loop,
                                  semantic_eval_chars: n,
                                },
                              },
                            }))
                          }
                        />
                        <div className="flex items-center justify-between gap-3 sm:col-span-2 lg:col-span-1 rounded-[var(--radius-md)] border border-border px-3 py-2">
                          <span className="text-xs text-foreground-secondary">semantic_content_enabled</span>
                          <Switch
                            checked={draftConfig.detectors.llm_thinking_loop.semantic_content_enabled}
                            onCheckedChange={(v) =>
                              setDraftConfig((c) => ({
                                ...c,
                                detectors: {
                                  ...c.detectors,
                                  llm_thinking_loop: {
                                    ...c.detectors.llm_thinking_loop,
                                    semantic_content_enabled: v,
                                  },
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        <NumberField
                          label="warning_threshold"
                          value={draftConfig.detectors.repeat_tool.warning_threshold}
                          min={2}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                repeat_tool: { ...c.detectors.repeat_tool, warning_threshold: n },
                              },
                            }))
                          }
                        />
                        <NumberField
                          label="critical_threshold"
                          value={draftConfig.detectors.repeat_tool.critical_threshold}
                          min={2}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                repeat_tool: { ...c.detectors.repeat_tool, critical_threshold: n },
                              },
                            }))
                          }
                        />
                        <NumberField
                          label="global_breaker_threshold"
                          value={draftConfig.detectors.repeat_tool.global_breaker_threshold}
                          min={2}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                repeat_tool: {
                                  ...c.detectors.repeat_tool,
                                  global_breaker_threshold: n,
                                },
                              },
                            }))
                          }
                        />
                        <NumberField
                          label="unknown_tool_threshold"
                          value={draftConfig.detectors.repeat_tool.unknown_tool_threshold}
                          min={2}
                          onChange={(n) =>
                            setDraftConfig((c) => ({
                              ...c,
                              detectors: {
                                ...c.detectors,
                                repeat_tool: {
                                  ...c.detectors.repeat_tool,
                                  unknown_tool_threshold: n,
                                },
                              },
                            }))
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
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
            <div className="text-xs text-foreground-muted font-mono">
              {envelope
                ? `rev ${envelope.revision} · ${new Date(envelope.updatedAt).toLocaleString()}`
                : '—'}
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
