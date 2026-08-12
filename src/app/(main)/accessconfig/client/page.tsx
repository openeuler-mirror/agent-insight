'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppTopBar } from '@/components/shell/AppTopBar'
import { PageContainer } from '@/components/shell/PageContainer'
import { useAuth } from '@/lib/auth/auth-context'
import { apiFetch } from '@/lib/client/api'
import { useLocale } from '@/lib/client/locale-context'

type ClientItem = {
  id: string
  name: string
  hostname: string | null
  reportedIp: string | null
  observedIp?: string | null
  status: string
  lastSeenAt: string
  platforms: Array<{ id: string; version?: string; models?: string[] }>
}

type SchemaField = {
  key: string
  label: string
  type: string
  min?: number
  max?: number
}

type SchemaSection = {
  key: string
  title: string
  description?: string
  enabledField?: string
  fields: SchemaField[]
}

type ConfigSchema = {
  platform: string
  configVersion: string
  title: string
  defaults: Record<string, unknown>
  sections: SchemaSection[]
}

type ConfigView = {
  clientId: string
  platform: string
  revision: number
  overrideDiff: Record<string, unknown>
  effectiveConfig: Record<string, unknown>
  fieldSources: Record<string, string>
  delivery: {
    status: string
    configRef?: string | null
    configVersion?: string | null
    error?: { code: string; message: string } | null
  } | null
}

const DELIVERY_STEPS = [
  { key: 'saved', label: '配置已保存' },
  { key: 'sync_notified', label: '通知客户端同步' },
  { key: 'pulling', label: '客户端拉取' },
  { key: 'written', label: '本地已写入' },
  { key: 'ras_loaded', label: 'RAS 已加载' },
] as const

const FAIL_STATUSES = new Set([
  'notify_failed',
  'pull_failed',
  'write_failed',
  'load_failed',
  'version_mismatch',
])

function stepIndex(status: string | undefined): number {
  const s = String(status || '').toLowerCase()
  if (s === 'notify_failed') return 0
  const idx = DELIVERY_STEPS.findIndex((step) => step.key === s)
  return idx >= 0 ? idx : -1
}

function flatFromNested(nested: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(nested || {})) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatFromNested(value as Record<string, unknown>, path))
    } else {
      out[path] = value
    }
  }
  return out
}

function sameFlat(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type SyncBadgeKind = 'unsynced' | 'syncing' | 'active' | 'failed'

function syncBadgeKind(status: string | undefined): SyncBadgeKind {
  const s = String(status || '').toLowerCase()
  if (!s || s === 'saved') return 'unsynced'
  if (FAIL_STATUSES.has(s)) return 'failed'
  if (s === 'ras_loaded') return 'active'
  if (s === 'sync_notified' || s === 'pulling' || s === 'written') return 'syncing'
  return 'unsynced'
}

export default function AccessClientConfigPage() {
  const { user } = useAuth()
  const { locale } = useLocale()
  const isZh = locale === 'zh'

  const [keyword, setKeyword] = useState('')
  const [clients, setClients] = useState<ClientItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [platform, setPlatform] = useState('opencode')
  const [schema, setSchema] = useState<ConfigSchema | null>(null)
  const [view, setView] = useState<ConfigView | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [baseline, setBaseline] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(
    () => clients.find((c) => c.id === selectedId) || null,
    [clients, selectedId],
  )

  const dirty = useMemo(() => !sameFlat(draft, baseline), [draft, baseline])

  const loadClients = useCallback(async () => {
    if (!user) return
    const res = await apiFetch(
      `/api/reliability/clients?user=${encodeURIComponent(user)}&keyword=${encodeURIComponent(keyword)}&pageSize=50`,
    )
    if (!res.ok) throw new Error('failed to load clients')
    const data = await res.json()
    const items = Array.isArray(data.items) ? (data.items as ClientItem[]) : []
    setClients(items)
    if (!selectedId && items[0]) setSelectedId(items[0].id)
    if (selectedId && !items.some((item) => item.id === selectedId) && items[0]) {
      setSelectedId(items[0].id)
    }
  }, [user, keyword, selectedId])

  const applyConfigView = useCallback((schemaJson: ConfigSchema, cfgJson: ConfigView, resetDraft: boolean) => {
    setSchema(schemaJson)
    setView(cfgJson)
    if (!resetDraft) return
    const flat = flatFromNested(cfgJson.effectiveConfig || {})
    setDraft(flat)
    setBaseline(flat)
  }, [])

  const loadConfig = useCallback(async (opts?: { resetDraft?: boolean }) => {
    if (!user || !selectedId) return
    const resetDraft = opts?.resetDraft !== false
    const [schemaRes, cfgRes] = await Promise.all([
      apiFetch(`/api/reliability/config-schemas/${encodeURIComponent(platform)}`),
      apiFetch(
        `/api/reliability/clients/${encodeURIComponent(selectedId)}/config?platform=${encodeURIComponent(platform)}&user=${encodeURIComponent(user)}`,
      ),
    ])
    if (!schemaRes.ok) throw new Error('schema load failed')
    if (!cfgRes.ok) throw new Error('config load failed')
    const schemaJson = (await schemaRes.json()) as ConfigSchema
    const cfgJson = (await cfgRes.json()) as ConfigView
    applyConfigView(schemaJson, cfgJson, resetDraft)
  }, [user, selectedId, platform, applyConfigView])

  const refreshDelivery = useCallback(async () => {
    if (!user || !selectedId) return
    const cfgRes = await apiFetch(
      `/api/reliability/clients/${encodeURIComponent(selectedId)}/config?platform=${encodeURIComponent(platform)}&user=${encodeURIComponent(user)}`,
    )
    if (!cfgRes.ok) return
    const cfgJson = (await cfgRes.json()) as ConfigView
    setView(cfgJson)
  }, [user, selectedId, platform])

  useEffect(() => {
    loadClients().catch((err) => setError(String(err?.message || err)))
  }, [loadClients])

  useEffect(() => {
    if (!selectedId) return
    const plats = selected?.platforms?.map((p) => p.id).filter(Boolean)
    if (plats?.length && !plats.includes(platform)) {
      setPlatform(plats[0])
      return
    }
    loadConfig({ resetDraft: true }).catch((err) => setError(String(err?.message || err)))
  }, [selectedId, platform, selected, loadConfig])

  useEffect(() => {
    if (!view?.delivery?.status) return
    const status = String(view.delivery.status).toLowerCase()
    if (status === 'saved' || status === 'ras_loaded' || FAIL_STATUSES.has(status)) return
    const timer = setInterval(() => {
      refreshDelivery().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [view?.delivery?.status, refreshDelivery])

  const overrideCount = useMemo(() => Object.keys(view?.overrideDiff || {}).length, [view])

  const setField = (key: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const buildOverrideDiff = (): Record<string, unknown> => {
    if (!schema) return {}
    const diff: Record<string, unknown> = {}
    for (const [key, defVal] of Object.entries(schema.defaults || {})) {
      const cur = draft[key]
      if (cur === undefined) continue
      if (JSON.stringify(cur) !== JSON.stringify(defVal)) diff[key] = cur
    }
    return diff
  }

  const save = async (sync: boolean) => {
    if (!user || !selectedId) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await apiFetch(
        `/api/reliability/clients/${encodeURIComponent(selectedId)}/config?platform=${encodeURIComponent(platform)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user,
            expectedRevision: view?.revision,
            overrideDiff: buildOverrideDiff(),
            sync,
          }),
        },
      )
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setError(isZh ? '配置已被更新，已刷新最新版本，请重试保存' : 'Config revision conflict; refreshed. Please retry.')
        await loadConfig({ resetDraft: true })
        return
      }
      if (!res.ok) throw new Error(data.error || data.code || `HTTP ${res.status}`)
      if (data.sync?.status === 'failed') {
        setMessage(data.sync?.error?.message || (isZh ? '已保存，同步失败' : 'Saved, sync failed'))
      } else {
        setMessage(sync ? (isZh ? '已保存并通知同步' : 'Saved and sync notified') : (isZh ? '仅已保存' : 'Saved'))
      }
      await loadConfig({ resetDraft: true })
    } catch (err) {
      setError(String((err as Error)?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const restoreDefault = async () => {
    if (!user || !selectedId) return
    if (!window.confirm(isZh ? '确认恢复平台默认？将清空当前客户端覆盖项。' : 'Restore platform defaults? This clears client overrides.')) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch(
        `/api/reliability/clients/${encodeURIComponent(selectedId)}/config?platform=${encodeURIComponent(platform)}&sync=false&user=${encodeURIComponent(user)}`,
        { method: 'DELETE' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || data.code || `HTTP ${res.status}`)
      setMessage(isZh ? '已恢复平台默认' : 'Restored platform defaults')
      await loadConfig({ resetDraft: true })
    } catch (err) {
      setError(String((err as Error)?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const deliveryStatus = String(view?.delivery?.status || '').toLowerCase()
  const activeStep = stepIndex(deliveryStatus)
  const syncKind = syncBadgeKind(deliveryStatus)
  const syncBadgeLabel = (() => {
    if (syncKind === 'active') return isZh ? '已生效' : 'Active'
    if (syncKind === 'syncing') return isZh ? '同步中' : 'Syncing'
    if (syncKind === 'failed') return isZh ? '同步失败' : 'Sync failed'
    return isZh ? '未同步' : 'Not synced'
  })()
  const syncBadgeColor = (() => {
    if (syncKind === 'active') return 'var(--color-success, #16a34a)'
    if (syncKind === 'failed') return 'var(--color-danger, #dc2626)'
    if (syncKind === 'syncing') return 'var(--primary)'
    return 'var(--muted-foreground)'
  })()

  return (
    <>
      <AppTopBar title={isZh ? '客户端配置' : 'Client Config'} />
      <PageContainer>
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, height: 'calc(100vh - 120px)', minHeight: 560 }}>
          <aside
            style={{
              border: '1px solid var(--border)',
              borderRadius: 12,
              background: 'var(--card-bg)',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minHeight: 0,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>{isZh ? '选择客户端' : 'Select client'}</div>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={isZh ? '搜索 IP / 主机名' : 'Search IP / hostname'}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 10px',
                background: 'var(--background)',
              }}
            />
            <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {clients.length === 0 && (
                <div style={{ color: 'var(--muted-foreground)', fontSize: 13, padding: 8 }}>
                  {isZh ? '暂无客户端。请先启动本机 FI Worker。' : 'No clients. Start FI Worker first.'}
                </div>
              )}
              {clients.map((client) => {
                const active = client.id === selectedId
                return (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => setSelectedId(client.id)}
                    style={{
                      textAlign: 'left',
                      border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                      background: active ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'transparent',
                      borderRadius: 10,
                      padding: '10px 12px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 99,
                          background: client.status === 'online' ? 'var(--color-success, #16a34a)' : 'var(--muted-foreground)',
                        }}
                      />
                      {client.reportedIp || client.observedIp || client.hostname || client.id}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4 }}>
                      {client.hostname || '—'} · {client.platforms?.length || 0} platforms
                    </div>
                  </button>
                )
              })}
            </div>
          </aside>

          <section
            style={{
              border: '1px solid var(--border)',
              borderRadius: 12,
              background: 'var(--card-bg)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            {!selected ? (
              <div style={{ padding: 24, color: 'var(--muted-foreground)' }}>
                {isZh ? '请选择左侧客户端' : 'Select a client'}
              </div>
            ) : (
              <>
                <header style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 18, fontWeight: 650 }}>
                    {selected.reportedIp || selected.observedIp || '—'} · {selected.hostname || '—'}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted-foreground)' }}>
                    {selected.id} · {selected.status === 'online' ? (isZh ? '在线' : 'online') : (isZh ? '离线' : 'offline')} ·{' '}
                    {isZh ? '最近心跳' : 'last seen'} {selected.lastSeenAt} · rev {view?.revision ?? 0}
                  </div>
                </header>

                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8 }}>
                  {(selected.platforms?.length ? selected.platforms : [{ id: 'opencode' }]).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPlatform(p.id)}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 999,
                        padding: '4px 12px',
                        background: platform === p.id ? 'var(--primary)' : 'transparent',
                        color: platform === p.id ? 'var(--primary-foreground, #fff)' : 'inherit',
                        cursor: 'pointer',
                        fontSize: 13,
                      }}
                    >
                      {p.id}
                    </button>
                  ))}
                </div>

                <div
                  style={{
                    margin: 16,
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    background: 'color-mix(in srgb, var(--foreground) 3%, transparent)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ fontSize: 13 }}>
                    {isZh ? '配置来源：平台内置默认 + 当前客户端覆盖' : 'Source: builtin defaults + client overrides'}
                    {dirty && (
                      <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--primary)' }}>
                        {isZh ? '· 有未保存修改' : '· Unsaved changes'}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span
                      style={{
                        fontSize: 12,
                        borderRadius: 999,
                        padding: '2px 10px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {overrideCount > 0 ? (isZh ? '已覆盖' : 'Overridden') : (isZh ? '未覆盖' : 'No override')}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        borderRadius: 999,
                        padding: '2px 10px',
                        border: `1px solid ${syncBadgeColor}`,
                        color: syncBadgeColor,
                      }}
                      title={
                        syncKind === 'syncing'
                          ? (isZh
                            ? '已通知客户端；控制通道未接通时会长时间停留在此状态'
                            : 'Notified; may stay here without control channel')
                          : undefined
                      }
                    >
                      {syncBadgeLabel}
                    </span>
                  </div>
                </div>

                <div style={{ padding: '0 16px 16px', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {(schema?.sections || []).map((section) => (
                    <div key={section.key} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{section.title}</div>
                      {section.description && (
                        <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 10 }}>
                          {section.description}
                        </div>
                      )}
                      <div style={{ display: 'grid', gap: 10 }}>
                        {section.fields.map((field) => {
                          const source = view?.fieldSources?.[field.key] || 'builtin'
                          const value = draft[field.key]
                          return (
                            <label key={field.key} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                              <span style={{ fontSize: 13 }}>
                                {field.label}
                                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted-foreground)' }}>
                                  {source === 'client_override' ? (isZh ? '客户端覆盖' : 'override') : (isZh ? '平台默认' : 'builtin')}
                                </span>
                              </span>
                              {field.type === 'boolean' ? (
                                <input
                                  type="checkbox"
                                  checked={Boolean(value)}
                                  onChange={(e) => setField(field.key, e.target.checked)}
                                />
                              ) : (
                                <input
                                  type="number"
                                  value={Number(value ?? 0)}
                                  min={field.min}
                                  max={field.max}
                                  onChange={(e) => setField(field.key, Number(e.target.value))}
                                  style={{
                                    width: 120,
                                    border: '1px solid var(--border)',
                                    borderRadius: 8,
                                    padding: '6px 8px',
                                    background: 'var(--background)',
                                  }}
                                />
                              )}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  ))}

                  <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>
                      {isZh ? '配置同步与生效状态' : 'Config sync status'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {DELIVERY_STEPS.map((step, idx) => {
                        const done = activeStep >= idx && !FAIL_STATUSES.has(deliveryStatus)
                        const current = activeStep === idx
                        return (
                          <div
                            key={step.key}
                            style={{
                              fontSize: 12,
                              padding: '6px 10px',
                              borderRadius: 8,
                              border: `1px solid ${current ? 'var(--primary)' : 'var(--border)'}`,
                              background: done
                                ? 'color-mix(in srgb, var(--primary) 12%, transparent)'
                                : 'transparent',
                              opacity: done || current ? 1 : 0.55,
                            }}
                          >
                            {step.label}
                          </div>
                        )
                      })}
                    </div>
                    {FAIL_STATUSES.has(deliveryStatus) && (
                      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-danger, #dc2626)' }}>
                        {view?.delivery?.error?.message || deliveryStatus}
                      </div>
                    )}
                    {syncKind === 'syncing' && (
                      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted-foreground)' }}>
                        {isZh
                          ? '已通知客户端同步，但本轮未接通控制通道，状态可能长时间停留在「通知客户端同步」。编辑中的表单不会被同步轮询覆盖。'
                          : 'Sync notified, but control channel is not wired this round — status may stay here. In-progress edits are not overwritten by sync polling.'}
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted-foreground)' }}>
                      {isZh
                        ? '说明：本地已写入 ≠ RAS 已加载。同步依赖客户端拉取快照与加载回报（本轮不上 WSS）。「未覆盖」指无客户端覆盖项，「未同步/同步中/已生效」指下发状态。'
                        : 'Note: written ≠ RAS loaded. Sync relies on pull + load report (no WSS). Override badge ≠ sync badge.'}
                    </div>
                  </div>
                </div>

                <footer
                  style={{
                    borderTop: '1px solid var(--border)',
                    padding: '12px 16px',
                    display: 'flex',
                    gap: 8,
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    flexShrink: 0,
                    background: 'var(--card-bg)',
                  }}
                >
                  {(message || error) && (
                    <span style={{ marginRight: 'auto', fontSize: 12, color: error ? 'var(--color-danger, #dc2626)' : 'var(--muted-foreground)' }}>
                      {error || message}
                    </span>
                  )}
                  <button type="button" disabled={busy} onClick={() => restoreDefault()} className="ai-btn-s">
                    {isZh ? '恢复平台默认' : 'Restore defaults'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => save(false)} className="ai-btn-s">
                    {isZh ? '仅保存' : 'Save only'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => save(true)} className="ai-btn-p">
                    {isZh ? '保存并通知同步' : 'Save & sync'}
                  </button>
                </footer>
              </>
            )}
          </section>
        </div>
      </PageContainer>
    </>
  )
}
