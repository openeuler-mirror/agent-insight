'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

type SyncBadgeKind = 'unsynced' | 'pending_pull' | 'published' | 'active' | 'failed'

type PlatformBadgeSummary = {
  platform: string
  overrideCount: number
  deliveryStatus: string
}

function syncBadgeKind(status: string | undefined): SyncBadgeKind {
  const s = String(status || '').toLowerCase()
  if (!s || s === 'saved') return 'unsynced'
  if (FAIL_STATUSES.has(s)) return 'failed'
  if (s === 'ras_loaded') return 'active'
  // written = 已写入拉取通道（本轮无 WSS，等同「已发布待 RAS 加载」）
  if (s === 'written') return 'published'
  if (s === 'sync_notified' || s === 'pulling') return 'pending_pull'
  return 'unsynced'
}

function syncBadgeLabelFor(kind: SyncBadgeKind, isZh: boolean): string {
  if (kind === 'active') return isZh ? '已生效' : 'Active'
  if (kind === 'published') return isZh ? '已发布' : 'Published'
  if (kind === 'pending_pull') return isZh ? '待拉取' : 'Pending pull'
  if (kind === 'failed') return isZh ? '同步失败' : 'Sync failed'
  return isZh ? '未同步' : 'Not synced'
}

function syncBadgeColorFor(kind: SyncBadgeKind): string {
  if (kind === 'active') return 'var(--color-success, #16a34a)'
  if (kind === 'failed') return 'var(--color-danger, #dc2626)'
  if (kind === 'published' || kind === 'pending_pull') return 'var(--primary)'
  return 'var(--muted-foreground)'
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
  const [configLoading, setConfigLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [platformSummaries, setPlatformSummaries] = useState<PlatformBadgeSummary[]>([])
  const loadGenRef = useRef(0)

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
    const gen = ++loadGenRef.current
    const requestPlatform = platform
    const requestClientId = selectedId
    setConfigLoading(true)
    try {
      const [schemaRes, cfgRes] = await Promise.all([
        apiFetch(`/api/reliability/config-schemas/${encodeURIComponent(requestPlatform)}`),
        apiFetch(
          `/api/reliability/clients/${encodeURIComponent(requestClientId)}/config?platform=${encodeURIComponent(requestPlatform)}&user=${encodeURIComponent(user)}`,
        ),
      ])
      if (!schemaRes.ok) throw new Error('schema load failed')
      if (!cfgRes.ok) throw new Error('config load failed')
      const schemaJson = (await schemaRes.json()) as ConfigSchema
      const cfgJson = (await cfgRes.json()) as ConfigView
      // 过期响应丢弃，避免平台切换时把 A 的配置画到 B 上。
      if (gen !== loadGenRef.current) return
      if (cfgJson.platform && cfgJson.platform !== requestPlatform) return
      if (schemaJson.platform && schemaJson.platform !== requestPlatform) return
      applyConfigView(schemaJson, cfgJson, resetDraft)
    } finally {
      if (gen === loadGenRef.current) setConfigLoading(false)
    }
  }, [user, selectedId, platform, applyConfigView])

  const refreshDelivery = useCallback(async () => {
    if (!user || !selectedId) return
    const requestPlatform = platform
    const cfgRes = await apiFetch(
      `/api/reliability/clients/${encodeURIComponent(selectedId)}/config?platform=${encodeURIComponent(requestPlatform)}&user=${encodeURIComponent(user)}`,
    )
    if (!cfgRes.ok) return
    const cfgJson = (await cfgRes.json()) as ConfigView
    if (cfgJson.platform && cfgJson.platform !== requestPlatform) return
    setView(cfgJson)
    setPlatformSummaries((prev) => {
      const next = prev.map((row) =>
        row.platform === requestPlatform
          ? {
              platform: requestPlatform,
              overrideCount: Object.keys(cfgJson.overrideDiff || {}).length,
              deliveryStatus: String(cfgJson.delivery?.status || ''),
            }
          : row,
      )
      if (next.some((row) => row.platform === requestPlatform)) return next
      return [
        ...next,
        {
          platform: requestPlatform,
          overrideCount: Object.keys(cfgJson.overrideDiff || {}).length,
          deliveryStatus: String(cfgJson.delivery?.status || ''),
        },
      ]
    })
  }, [user, selectedId, platform])

  useEffect(() => {
    loadClients().catch((err) => setError(String(err?.message || err)))
  }, [loadClients])

  const selectedPlatformIds = useMemo(
    () => (selected?.platforms || []).map((p) => p.id).filter(Boolean),
    [selected],
  )
  const selectedPlatformKey = selectedPlatformIds.join(',')

  const loadPlatformSummaries = useCallback(async () => {
    if (!user || !selectedId) {
      setPlatformSummaries([])
      return
    }
    const plats = selectedPlatformKey
      ? selectedPlatformKey.split(',').filter(Boolean)
      : [platform]
    const rows = await Promise.all(
      plats.map(async (p) => {
        try {
          const cfgRes = await apiFetch(
            `/api/reliability/clients/${encodeURIComponent(selectedId)}/config?platform=${encodeURIComponent(p)}&user=${encodeURIComponent(user)}`,
          )
          if (!cfgRes.ok) {
            return { platform: p, overrideCount: 0, deliveryStatus: '' }
          }
          const cfgJson = (await cfgRes.json()) as ConfigView
          return {
            platform: p,
            overrideCount: Object.keys(cfgJson.overrideDiff || {}).length,
            deliveryStatus: String(cfgJson.delivery?.status || ''),
          }
        } catch {
          return { platform: p, overrideCount: 0, deliveryStatus: '' }
        }
      }),
    )
    setPlatformSummaries(rows)
  }, [user, selectedId, selectedPlatformKey, platform])

  useEffect(() => {
    if (!selectedId) {
      setPlatformSummaries([])
      return
    }
    loadPlatformSummaries().catch(() => undefined)
  }, [selectedId, selectedPlatformKey, loadPlatformSummaries])

  useEffect(() => {
    if (!selectedId) return
    if (selectedPlatformIds.length && !selectedPlatformIds.includes(platform)) {
      setPlatform(selectedPlatformIds[0])
      return
    }
    // 切换客户端/平台时清空，杜绝上一平台 draft 残留串扰。
    setSchema(null)
    setView(null)
    setDraft({})
    setBaseline({})
    setMessage(null)
    loadConfig({ resetDraft: true })
      .then(() => loadPlatformSummaries())
      .catch((err) => setError(String(err?.message || err)))
  }, [selectedId, platform, selectedPlatformKey, selectedPlatformIds, loadConfig, loadPlatformSummaries])

  useEffect(() => {
    if (!view?.delivery?.status) return
    const status = String(view.delivery.status).toLowerCase()
    if (status === 'saved' || status === 'ras_loaded' || status === 'written' || FAIL_STATUSES.has(status)) return
    const timer = setInterval(() => {
      refreshDelivery().catch(() => undefined)
    }, 3000)
    return () => clearInterval(timer)
  }, [view?.delivery?.status, refreshDelivery])

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
      } else if (sync) {
        setMessage(isZh ? '已保存并发布到该平台拉取通道' : 'Saved and published to platform pull channel')
      } else {
        setMessage(isZh ? '仅已保存' : 'Saved')
      }
      await loadConfig({ resetDraft: true })
      await loadPlatformSummaries()
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
      await loadPlatformSummaries()
    } catch (err) {
      setError(String((err as Error)?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const deliveryStatus = String(
    (view?.platform === platform ? view?.delivery?.status : null)
      || platformSummaries.find((row) => row.platform === platform)?.deliveryStatus
      || '',
  ).toLowerCase()
  const activeStep = stepIndex(deliveryStatus)
  const syncKind = syncBadgeKind(deliveryStatus)
  const formReady = Boolean(view && view.platform === platform && !configLoading)

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
                      onClick={() => {
                        if (p.id === platform) return
                        setPlatform(p.id)
                      }}
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
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 13 }}>
                      {isZh
                        ? `配置来源：平台内置默认 + 当前客户端对「${platform}」的覆盖`
                        : `Source: builtin defaults + client overrides for ${platform}`}
                      {dirty && formReady && (
                        <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--primary)' }}>
                          {isZh ? '· 有未保存修改' : '· Unsaved changes'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(platformSummaries.length
                      ? platformSummaries
                      : [{ platform, overrideCount: 0, deliveryStatus: '' }]
                    ).map((row) => {
                      const kind = syncBadgeKind(row.deliveryStatus)
                      const color = syncBadgeColorFor(kind)
                      const active = row.platform === platform
                      return (
                        <button
                          key={row.platform}
                          type="button"
                          onClick={() => {
                            if (row.platform !== platform) setPlatform(row.platform)
                          }}
                          title={isZh ? `${row.platform} 平台状态（点击切换）` : `${row.platform} status (click to switch)`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 12,
                            borderRadius: 10,
                            padding: '6px 10px',
                            border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                            background: active
                              ? 'color-mix(in srgb, var(--primary) 10%, transparent)'
                              : 'transparent',
                            cursor: 'pointer',
                            color: 'inherit',
                          }}
                        >
                          <span style={{ fontWeight: 650 }}>{row.platform}</span>
                          <span
                            style={{
                              borderRadius: 999,
                              padding: '1px 8px',
                              border: '1px solid var(--border)',
                            }}
                          >
                            {row.overrideCount > 0
                              ? (isZh ? `已覆盖(${row.overrideCount})` : `Overridden(${row.overrideCount})`)
                              : (isZh ? '未覆盖' : 'No override')}
                          </span>
                          <span
                            style={{
                              borderRadius: 999,
                              padding: '1px 8px',
                              border: `1px solid ${color}`,
                              color,
                            }}
                          >
                            {syncBadgeLabelFor(kind, isZh)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div style={{ padding: '0 16px 16px', overflow: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {!formReady && (
                    <div style={{ fontSize: 13, color: 'var(--muted-foreground)', padding: 8 }}>
                      {isZh ? '正在加载该平台配置…' : 'Loading platform config…'}
                    </div>
                  )}
                  {formReady && (schema?.sections || []).map((section) => (
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

                  {formReady && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>
                      {isZh ? '配置同步与生效状态' : 'Config sync status'}
                      <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--muted-foreground)' }}>
                        · {platform}
                      </span>
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
                    {syncKind === 'pending_pull' && (
                      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted-foreground)' }}>
                        {isZh
                          ? '状态停留在「通知客户端同步」：本轮无 WSS。请再点「保存并通知同步」写入该平台拉取通道，或等待插件启动拉取。'
                          : 'Stuck at sync_notified (no WSS). Re-save & sync to publish this platform’s pull channel, or wait for plugin pull.'}
                      </div>
                    )}
                    {syncKind === 'published' && (
                      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted-foreground)' }}>
                        {isZh
                          ? '已按当前平台发布到 ras-config 拉取通道。OpenCode 重启插件 / xiaoO 新会话后合并本地配置；「已生效」需 RAS 加载回报（本轮可能仍显示已发布）。'
                          : 'Published to ras-config pull channel for this platform. Plugin/session restart merges locally; Active needs RAS load report.'}
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted-foreground)' }}>
                      {isZh
                        ? '说明：各平台配置独立存储与下发，互不覆盖。「未覆盖」指无客户端覆盖项，「未同步/待拉取/已发布/已生效」指该平台下发状态。'
                        : 'Note: each platform’s config is isolated. Override badge ≠ sync badge.'}
                    </div>
                  </div>
                  )}
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
                  <button type="button" disabled={busy || !formReady} onClick={() => restoreDefault()} className="ai-btn-s">
                    {isZh ? '恢复平台默认' : 'Restore defaults'}
                  </button>
                  <button type="button" disabled={busy || !formReady} onClick={() => save(false)} className="ai-btn-s">
                    {isZh ? '仅保存' : 'Save only'}
                  </button>
                  <button type="button" disabled={busy || !formReady} onClick={() => save(true)} className="ai-btn-p">
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
