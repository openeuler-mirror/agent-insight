'use client'

import { Suspense } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FiPageShell } from '@/components/fault-injection/FiPageShell'
import { FaultTable, type FaultTableRow } from '@/components/fault-injection/FaultTable'
import { WizardSummary } from '@/components/fault-injection/WizardSummary'
import {
  faultDisplayName,
  normalizeFault,
  type FaultItem,
  type PlatformInfo,
  type PlatformOption,
} from '@/components/fault-injection/types'
import { useAuth } from '@/lib/auth/auth-context'
import { cn } from '@/lib/utils'

function FaultInjectionTaskWizardPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const rerunFrom = searchParams.get('rerunFrom')
  const { apiKey } = useAuth()

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers['x-witty-api-key'] = apiKey
    return headers
  }, [apiKey])

  const [step, setStep] = useState(1)
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([])
  const [faults, setFaults] = useState<FaultItem[]>([])
  const [selected, setSelected] = useState<Map<string, { fault: string; submode: string | null }>>(
    new Map(),
  )
  const [platform, setPlatform] = useState('opencode')
  const [agent, setAgent] = useState('build')
  const [model, setModel] = useState('')
  const [agentOptions, setAgentOptions] = useState<PlatformOption[]>([])
  const [modelOptions, setModelOptions] = useState<PlatformOption[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('执行注入场景')
  const [workspace, setWorkspace] = useState('~/.agent-insight/fault-injection/workspaces')
  const [timeoutSeconds, setTimeoutSeconds] = useState(180)
  const [dryRun, setDryRun] = useState(false)
  const [needsWorker, setNeedsWorker] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [rerunLoaded, setRerunLoaded] = useState(false)

  useEffect(() => {
    void fetch('/api/fault-injection/health', { headers: authHeaders })
      .then((r) => r.json())
      .then((data) => {
        setPlatforms(data.platforms || [])
        setNeedsWorker(Boolean(data.needsWorker && !data.ok))
        if (typeof data.dryRunDefault === 'boolean') setDryRun(data.dryRunDefault)
        const ready = (data.platforms || []).find((p: PlatformInfo) => p.readiness === 'ready')
        if (ready && !rerunFrom) setPlatform(ready.id)
      })
      .catch(() => undefined)
  }, [rerunFrom, authHeaders])

  const refreshCatalog = useCallback(
    async (platformId: string) => {
      const [agentsRes, modelsRes, faultsRes] = await Promise.all([
        fetch(`/api/fault-injection/platforms/${platformId}/agents`, { headers: authHeaders }),
        fetch(`/api/fault-injection/platforms/${platformId}/models`, { headers: authHeaders }),
        fetch(`/api/fault-injection/faults?platform=${encodeURIComponent(platformId)}`, {
          headers: authHeaders,
        }),
      ])
      const agents = await agentsRes.json()
      const models = await modelsRes.json()
      const faultData = await faultsRes.json()
      if (!agentsRes.ok) throw new Error(agents.error || 'load agents failed')
      if (!modelsRes.ok) throw new Error(models.error || 'load models failed')
      if (agents.source && agents.source !== 'worker') {
        throw new Error(
          agents.note || agents.error || 'agent catalog requires an online FI Worker',
        )
      }
      const agentOpts: PlatformOption[] = (agents.agents || []).map(
        (item: { id?: string; name?: string; label?: string }) => ({
          id: String(item.id || ''),
          label: String(item.label || item.name || item.id || ''),
        }),
      )
      const modelOpts: PlatformOption[] = (models.models || []).map(
        (item: { id?: string; name?: string; label?: string }) => ({
          id: String(item.id ?? ''),
          label: String(item.label || item.name || item.id || '平台默认'),
        }),
      )
      if (!agentOpts.length) throw new Error('平台未返回任何 Agent，无法创建任务')
      setAgentOptions(agentOpts)
      setModelOptions(modelOpts)
      setAgent((current) => {
        if (current && agentOpts.some((item) => item.id === current)) return current
        return agents.default || agentOpts[0]?.id || ''
      })
      setModel((current) => {
        if (current && modelOpts.some((item) => item.id === current)) return current
        return typeof models.default === 'string' ? models.default : ''
      })
      setFaults((faultData.faults || []).map((row: Record<string, unknown>) => normalizeFault(row)))
      if (agents.note) toast.message(String(agents.note))
    },
    [authHeaders],
  )
  useEffect(() => {
    void refreshCatalog(platform).catch((e) => toast.error(String(e.message || e)))
  }, [platform, refreshCatalog])

  useEffect(() => {
    if (!rerunFrom || rerunLoaded) return
    void fetch(`/api/fault-injection/task/${encodeURIComponent(rerunFrom)}`)
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'load task failed')
        const task = data.task
        setPlatform(task.platform || 'opencode')
        setAgent(task.agent || 'build')
        setModel(task.model || '')
        setPrompt(task.prompt || '')
        setWorkspace(task.workspace || '~/.agent-insight/fault-injection/workspaces')
        setName(`${String(task.name || '任务').replace(/\s*\(再次\)\s*$/, '')} (再次)`)
        const map = new Map<string, { fault: string; submode: string | null }>()
        for (const item of task.items || []) {
          const fault = String(item.fault || '')
          const submode = item.submode ? String(item.submode) : null
          const key = `${fault}::${submode || 'default'}`
          map.set(key, { fault, submode })
        }
        setSelected(map)
        setStep(3)
        setRerunLoaded(true)
      })
      .catch((e) => toast.error(String(e.message || e)))
  }, [rerunFrom, rerunLoaded])

  useEffect(() => {
    setSelected((prev) => {
      if (!faults.length || prev.size === 0) return prev
      const next = new Map(prev)
      let changed = false
      for (const [key, value] of prev) {
        const fault = faults.find((item) => item.id === value.fault)
        const platformsList = fault?.platforms
        if (platformsList?.length && !platformsList.includes(platform)) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [platform, faults])

  const toggleRow = (row: FaultTableRow) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(row.key)) next.delete(row.key)
      else {
        next.set(row.key, {
          fault: row.fault.id,
          submode: row.submode?.id || null,
        })
      }
      return next
    })
  }

  const faultLabels = useMemo(() => {
    return [...selected.values()].map((item) => {
      const fault = faults.find((f) => f.id === item.fault)
      const base = fault ? faultDisplayName(fault) : item.fault
      return item.submode ? `${base}/${item.submode}` : base
    })
  }, [selected, faults])

  const selectedPlatform = platforms.find((item) => item.id === platform)

  const checklist = [
    { ok: !!platform, label: '已选择平台' },
    {
      ok:
        platforms.length === 0 ||
        (!!selectedPlatform && selectedPlatform.readiness !== 'not_ready'),
      label: '平台可用',
    },
    { ok: selected.size > 0, label: '至少选择 1 个故障模式' },
    { ok: !!workspace.trim(), label: '已填写工作目录' },
    { ok: !!prompt.trim(), label: '已填写提示词' },
  ]

  const canNext =
    step === 1 ? !!platform : step === 2 ? selected.size > 0 : checklist.every((item) => item.ok)

  const autoName = () => {
    const stamp = new Date()
    const hh = String(stamp.getHours()).padStart(2, '0')
    const mm = String(stamp.getMinutes()).padStart(2, '0')
    return `${platform}-${selected.size || '?'}faults-${hh}${mm}`
  }

  const goNext = () => {
    if (step === 2 && !name.trim()) setName(autoName())
    setStep((s) => Math.min(3, s + 1))
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/fault-injection/tasks', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: name.trim() || autoName(),
          platform,
          agent,
          model: model.trim() || undefined,
          prompt,
          workspace: workspace.startsWith('~') ? undefined : workspace,
          timeout_seconds: timeoutSeconds,
          dryRun,
          items: [...selected.values()].map((item) => ({
            fault: item.fault,
            submode: item.submode,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'create failed')
      toast.success(`任务已创建：${data.task?.task_id}`)
      router.push(`/agent-ras/fault-injection/tasks/${data.task?.task_id}`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <FiPageShell hideSubNav>
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/agent-ras/fault-injection/tasks"
          className="text-sm text-primary hover:underline"
        >
          ← 返回
        </Link>
        <h1 className="text-lg font-semibold">
          {rerunFrom ? '再次运行注入任务' : '新建注入任务'}
        </h1>
      </div>

      <ol className="flex flex-wrap gap-4 text-sm font-medium text-foreground-muted">
        {(
          [
            [1, '选择平台'],
            [2, '选择故障模式'],
            [3, '配置并启动'],
          ] as const
        ).map(([n, label]) => (
          <li
            key={n}
            className={cn(
              step === n && 'text-primary',
              step > n && 'text-foreground',
            )}
          >
            {n}. {label}
          </li>
        ))}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card">
          <div className="min-h-0 flex-1 p-4">
            {step === 1 ? (
              <div className="space-y-3">
                <p className="text-sm text-foreground-muted">
                  任务锁定一个平台；子运行共享 Agent / Model。平台就绪来自本机 FI Worker inventory。
                </p>
                {needsWorker ? (
                  <p className="rounded-md border border-[var(--warning-border,var(--border))] bg-[var(--warning-subtle,var(--background-secondary))] px-3 py-2 text-sm text-foreground">
                    未检测到在线 FI Worker。请在本机执行：
                    <code className="mx-1 rounded bg-background px-1 py-0.5 text-xs">
                      npx agent-insight install-fault-injection --start
                    </code>
                    （Dry-run 可不启 Worker。）
                  </p>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  {platforms.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setPlatform(item.id)}
                      className={cn(
                        'rounded-md border p-3 text-left transition-colors hover:bg-background-secondary',
                        platform === item.id
                          ? 'border-primary bg-[var(--primary-subtle)]'
                          : 'border-border',
                      )}
                    >
                      <div className="font-medium">{item.label}</div>
                      <div className="mt-1 text-xs text-foreground-muted">
                        {item.readiness === 'ready' ? '就绪' : '不可用'}
                      </div>
                      {(item.preflight_errors || []).length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--error)]">
                          {item.preflight_errors!.map((err) => (
                            <li key={err}>{err}</li>
                          ))}
                        </ul>
                      ) : null}
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    <span className="text-foreground-muted">Agent</span>
                    <select
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
                      value={agent}
                      onChange={(e) => setAgent(e.target.value)}
                    >
                      {agentOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label || opt.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="text-foreground-muted">Model（可选）</span>
                    <select
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {modelOptions.map((opt) => (
                        <option key={opt.id || '__platform_default__'} value={opt.id}>
                          {opt.label || opt.id || '平台默认'}
                        </option>
                      ))}
                    </select>
                    {modelOptions.length <= 1 ? (
                      <span className="mt-1 block text-[11px] text-foreground-muted">
                        若列表过短，可能 FI Worker 尚未上报模型目录，或平台无可枚举模型。
                      </span>
                    ) : null}
                  </label>
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <FaultTable
                faults={faults}
                selectable
                compact
                className="min-h-[24rem]"
                selectedKeys={new Set(selected.keys())}
                onToggle={toggleRow}
              />
            ) : null}

            {step === 3 ? (
              <div className="space-y-3">
                <label className="block text-sm">
                  <span className="text-foreground-muted">任务名</span>
                  <input
                    className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
                    value={name}
                    placeholder={autoName()}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-foreground-muted">Prompt</span>
                  <textarea
                    className="mt-1 min-h-28 w-full rounded-md border border-border bg-background p-2"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <span className="mt-1 block text-[11px] text-foreground-muted">
                    建议包含场景编号或子模式名称，便于 Agent 进入对应注入路径。
                  </span>
                </label>
                <label className="block text-sm">
                  <span className="text-foreground-muted">工作目录</span>
                  <input
                    className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
                    value={workspace}
                    onChange={(e) => setWorkspace(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-foreground-muted">超时（秒）</span>
                  <input
                    type="number"
                    className="mt-1 w-40 rounded-md border border-border bg-background px-2 py-1.5"
                    value={timeoutSeconds}
                    onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 180)}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                  />
                  Dry-run（联调用 stub；真跑请关闭）
                </label>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={step <= 1 || submitting}
              onClick={() => setStep((s) => Math.max(1, s - 1))}
            >
              上一步
            </Button>
            {step < 3 ? (
              <Button size="sm" disabled={!canNext} onClick={goNext}>
                下一步
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canNext || submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting ? '启动中…' : '启动注入任务'}
              </Button>
            )}
          </div>
        </div>

        <WizardSummary
          platform={platform}
          agent={agent}
          model={model}
          faultLabels={faultLabels}
          workspace={workspace}
          checklist={checklist}
        />
      </div>
    </FiPageShell>
  )
}


export default function FaultInjectionTaskWizardPageSuspense() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-foreground-muted">加载中…</div>}>
      <FaultInjectionTaskWizardPage />
    </Suspense>
  )
}
