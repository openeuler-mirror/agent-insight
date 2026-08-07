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
import { useLocale } from '@/lib/client/locale-context'
import { cn } from '@/lib/utils'

type JudgeModelStatus = 'unknown' | 'ok' | 'missing'

function assessJudgeModelConfig(data: {
  activeConfigId?: string | null
  configs?: Array<{ id?: string; model?: string; baseUrl?: string; apiKey?: string }>
}): JudgeModelStatus {
  const configs = Array.isArray(data.configs) ? data.configs : []
  const activeId = data.activeConfigId
  const active = activeId ? configs.find((c) => c.id === activeId) : undefined
  if (!active) return 'missing'
  if (!String(active.model || '').trim()) return 'missing'
  const baseUrl = String(active.baseUrl || '').trim()
  const looksLocal =
    !baseUrl ||
    /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl) ||
    baseUrl.startsWith('/')
  const apiKey = String(active.apiKey || '').trim()
  if (!apiKey && !looksLocal) return 'missing'
  return 'ok'
}

function FaultInjectionTaskWizardPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const rerunFrom = searchParams.get('rerunFrom')
  const { user, apiKey } = useAuth()
  const { locale } = useLocale()
  const zh = locale === 'zh'

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
  const [prompt, setPrompt] = useState('')
  const [workspace, setWorkspace] = useState('~/.agent-insight/fault-injection/workspaces')
  const [timeoutSeconds, setTimeoutSeconds] = useState(180)
  const [needsWorker, setNeedsWorker] = useState(false)
  const [judgeModelStatus, setJudgeModelStatus] = useState<JudgeModelStatus>('unknown')
  const [submitting, setSubmitting] = useState(false)
  const [rerunLoaded, setRerunLoaded] = useState(false)
  const [copiedSetup, setCopiedSetup] = useState(false)

  const workerSetupCommand = useMemo(() => {
    if (!apiKey || typeof window === 'undefined') return null
    const origin = window.location.origin
    return `curl -fsSL "${origin}/api/fault-injection/setup?key=${apiKey}" | bash`
  }, [apiKey])

  const refreshJudgeModel = useCallback(async () => {
    if (!user) {
      setJudgeModelStatus('unknown')
      return
    }
    try {
      const res = await fetch(`/api/eval/settings?user=${encodeURIComponent(user)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'load settings failed')
      setJudgeModelStatus(assessJudgeModelConfig(data))
    } catch {
      setJudgeModelStatus('unknown')
    }
  }, [user])

  useEffect(() => {
    void refreshJudgeModel()
  }, [refreshJudgeModel])

  useEffect(() => {
    if (step !== 3) return
    void refreshJudgeModel()
  }, [step, refreshJudgeModel])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshJudgeModel()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refreshJudgeModel])

  useEffect(() => {
    void fetch('/api/fault-injection/health', { headers: authHeaders })
      .then((r) => r.json())
      .then((data) => {
        setPlatforms(data.platforms || [])
        setNeedsWorker(Boolean(!data.ok))
        const ready = (data.platforms || []).find((p: PlatformInfo) => p.readiness === 'ready')
        if (ready && !rerunFrom) setPlatform(ready.id)
      })
      .catch(() => undefined)
  }, [rerunFrom, authHeaders])

  const copySetupCommand = async () => {
    if (!workerSetupCommand) return
    try {
      await navigator.clipboard.writeText(workerSetupCommand)
      setCopiedSetup(true)
      toast.success(zh ? '已复制 setup 命令' : 'Setup command copied')
      window.setTimeout(() => setCopiedSetup(false), 2000)
    } catch {
      toast.error(zh ? '复制失败，请手动选中命令' : 'Copy failed; select the command manually')
    }
  }

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
      const platformDefault = zh ? '平台默认' : 'Platform default'
      const agentOpts: PlatformOption[] = (agents.agents || []).map(
        (item: { id?: string; name?: string; label?: string }) => ({
          id: String(item.id || ''),
          label: String(item.label || item.name || item.id || ''),
        }),
      )
      const modelOpts: PlatformOption[] = (models.models || []).map(
        (item: { id?: string; name?: string; label?: string }) => ({
          id: String(item.id ?? ''),
          label: String(item.label || item.name || item.id || platformDefault),
        }),
      )
      if (!agentOpts.length) {
        throw new Error(
          zh
            ? '平台未返回任何 Agent，无法创建任务'
            : 'Platform returned no agents; cannot create task',
        )
      }
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
    [authHeaders, zh],
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
        const againSuffix = zh ? '(再次)' : '(rerun)'
        const defaultTaskName = zh ? '任务' : 'Task'
        setName(
          `${String(task.name || defaultTaskName).replace(/\s*\((?:再次|rerun)\)\s*$/i, '')} ${againSuffix}`,
        )
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
  }, [rerunFrom, rerunLoaded, zh])

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
      const base = fault ? faultDisplayName(fault, locale) : item.fault
      return item.submode ? `${base}/${item.submode}` : base
    })
  }, [selected, faults, locale])

  const selectedPlatform = platforms.find((item) => item.id === platform)
  const platformReady =
    !!selectedPlatform && selectedPlatform.readiness === 'ready'

  const checklist = [
    { ok: !!platform, label: zh ? '已选择平台' : 'Platform selected' },
    { ok: platformReady, label: zh ? '平台可用' : 'Platform ready' },
    {
      ok: selected.size > 0,
      label: zh ? '至少选择 1 个故障模式' : 'Select at least 1 fault mode',
    },
    { ok: !!workspace.trim(), label: zh ? '已填写工作目录' : 'Workspace filled in' },
  ]

  const canNext =
    step === 1
      ? platformReady && agentOptions.length > 0
      : step === 2
        ? selected.size > 0
        : checklist.every((item) => item.ok)

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
          items: [...selected.values()].map((item) => ({
            fault: item.fault,
            submode: item.submode,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'create failed')
      toast.success(
        zh
          ? `任务已创建：${data.task?.task_id}`
          : `Task created: ${data.task?.task_id}`,
      )
      router.push(`/agent-ras/fault-injection/tasks/${data.task?.task_id}`)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const platformDefaultLabel = zh ? '平台默认' : 'Platform default'

  return (
    <FiPageShell className="overflow-hidden" contentClassName="min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <Link
          href="/agent-ras/fault-injection/tasks"
          className="text-sm text-primary hover:underline"
        >
          {zh ? '← 返回' : '← Back'}
        </Link>
        <h1 className="text-lg font-semibold">
          {rerunFrom
            ? zh
              ? '再次运行注入任务'
              : 'Rerun injection task'
            : zh
              ? '新建注入任务'
              : 'New injection task'}
        </h1>
      </div>

      <ol className="flex shrink-0 flex-wrap gap-4 text-sm font-medium text-foreground-muted">
        {(
          [
            [1, zh ? '选择平台' : 'Select platform'],
            [2, zh ? '选择故障模式' : 'Select fault modes'],
            [3, zh ? '配置并启动' : 'Configure & start'],
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

      <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
          <div
            className={cn(
              'min-h-0 flex-1 p-4',
              step === 2 ? 'flex flex-col overflow-hidden' : 'overflow-auto',
            )}
          >            {step === 1 ? (
              <div className="space-y-3">
                <p className="text-sm text-foreground-muted">
                  {zh
                    ? '任务锁定一个平台；子运行共享 Agent / Model。平台就绪来自本机 FI Worker inventory。'
                    : 'Each task locks one platform; sub-runs share Agent / Model. Platform readiness comes from the local FI Worker inventory.'}
                </p>
                {needsWorker ? (
                  <div className="space-y-2 rounded-md border border-[var(--warning-border,var(--border))] bg-[var(--warning-subtle,var(--background-secondary))] px-3 py-2 text-sm text-foreground">
                    <p>
                      {zh
                        ? '未检测到与当前登录账号匹配的在线 FI Worker。请在本机执行下方命令（已绑定本站与当前 API Key）：'
                        : 'No online FI Worker matching the current login was found. Run the command below on this machine (bound to this site and your API Key):'}
                    </p>
                    {workerSetupCommand ? (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <code className="block min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5 font-mono text-[11px]">
                          {workerSetupCommand}
                        </code>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void copySetupCommand()}
                        >
                          {copiedSetup
                            ? zh
                              ? '已复制'
                              : 'Copied'
                            : zh
                              ? '复制'
                              : 'Copy'}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-foreground-muted">
                        {zh
                          ? '请先登录并取得 API Key，再刷新本页生成安装命令。'
                          : 'Log in and obtain an API Key, then refresh this page to generate the install command.'}
                      </p>
                    )}
                    <p className="text-[11px] text-foreground-muted">
                      {zh
                        ? 'Worker 必须与当前登录账号一致，并保持进程常驻。'
                        : 'The Worker must match the current login and stay running.'}
                    </p>
                  </div>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  {platforms.map((item) => {
                    const ready = item.readiness === 'ready'
                    return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!ready}
                      onClick={() => {
                        if (!ready) return
                        setPlatform(item.id)
                      }}
                      className={cn(
                        'rounded-md border p-3 text-left transition-colors',
                        ready
                          ? 'hover:bg-background-secondary'
                          : 'cursor-not-allowed opacity-60',
                        platform === item.id
                          ? 'border-primary bg-[var(--primary-subtle)]'
                          : 'border-border',
                      )}
                    >
                      <div className="font-medium">{item.label}</div>
                      <div className="mt-1 text-xs text-foreground-muted">
                        {ready ? (zh ? '就绪' : 'Ready') : zh ? '不可用' : 'Unavailable'}
                      </div>
                      {(item.preflight_errors || []).length > 0 ? (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--error)]">
                          {item.preflight_errors!.map((err) => (
                            <li key={err}>{err}</li>
                          ))}
                        </ul>
                      ) : null}
                    </button>
                    )
                  })}
                </div>                <div className="grid gap-3 sm:grid-cols-2">
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
                    <span className="text-foreground-muted">
                      {zh ? 'Model（可选）' : 'Model (optional)'}
                    </span>
                    <select
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {modelOptions.map((opt) => (
                        <option key={opt.id || '__platform_default__'} value={opt.id}>
                          {opt.label || opt.id || platformDefaultLabel}
                        </option>
                      ))}
                    </select>
                    {modelOptions.length <= 1 ? (
                      <span className="mt-1 block text-[11px] text-foreground-muted">
                        {zh
                          ? '若列表过短，可能 FI Worker 尚未上报模型目录，或平台无可枚举模型。'
                          : 'If the list is short, the FI Worker may not have reported models yet, or the platform has none to enumerate.'}
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
                className="min-h-0 flex-1"
                selectedKeys={new Set(selected.keys())}
                onToggle={toggleRow}
              />
            ) : null}

            {step === 3 ? (
              <div className="space-y-3">
                {judgeModelStatus === 'missing' ? (
                  <div className="space-y-2 rounded-md border border-[var(--warning-border,var(--border))] bg-[var(--warning-subtle,var(--background-secondary))] px-3 py-2 text-sm text-foreground">
                    <p>
                      {zh
                        ? '未配置 Insight 激活模型。注入仍可启动，但服务端 Judge 会跳过（结果为「评判跳过」）。请先到模型注册设置并激活模型。'
                        : 'No active Insight model configured. Injection can still start, but server-side Judge will be skipped (result: “judgment skipped”). Set and activate a model in the model registry first.'}
                    </p>
                    <Link
                      href="/modelconfig/registry"
                      className="inline-flex text-sm font-medium text-primary hover:underline"
                    >
                      {zh ? '前往模型注册 →' : 'Go to model registry →'}
                    </Link>
                  </div>
                ) : null}
                <label className="block text-sm">
                  <span className="text-foreground-muted">
                    {zh ? '任务名' : 'Task name'}
                  </span>
                  <input
                    className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
                    value={name}
                    placeholder={autoName()}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-foreground-muted">
                    {zh ? '基础 Prompt（可选）' : 'Base prompt (optional)'}
                  </span>
                  <textarea
                    className="mt-1 min-h-28 w-full rounded-md border border-border bg-background p-2"
                    value={prompt}
                    placeholder={
                      zh
                        ? '可留空；每个故障会自动附加 Skill 激活指令'
                        : 'Optional; each fault auto-appends a Skill activation instruction'
                    }
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <span className="mt-1 block text-[11px] text-foreground-muted">
                    {zh
                      ? '每个故障模式会自动附加「使用 … 技能，执行…」激活指令；此处仅填写额外任务说明。'
                      : 'Each fault mode auto-appends a “use … skill, then …” activation instruction; add only extra task notes here.'}
                  </span>
                </label>
                <label className="block text-sm">
                  <span className="text-foreground-muted">
                    {zh ? '工作目录' : 'Workspace'}
                  </span>
                  <input
                    className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
                    value={workspace}
                    onChange={(e) => setWorkspace(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-foreground-muted">
                    {zh ? '超时（秒）' : 'Timeout (seconds)'}
                  </span>
                  <input
                    type="number"
                    className="mt-1 w-40 rounded-md border border-border bg-background px-2 py-1.5"
                    value={timeoutSeconds}
                    onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 180)}
                  />
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
              {zh ? '上一步' : 'Previous'}
            </Button>
            {step < 3 ? (
              <Button size="sm" disabled={!canNext} onClick={goNext}>
                {zh ? '下一步' : 'Next'}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canNext || submitting}
                onClick={() => void handleSubmit()}
              >
                {submitting
                  ? zh
                    ? '启动中…'
                    : 'Starting…'
                  : zh
                    ? '启动注入任务'
                    : 'Start injection task'}
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
      </div>
    </FiPageShell>
  )
}

function WizardSuspenseFallback() {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  return (
    <div className="p-6 text-sm text-foreground-muted">
      {zh ? '加载中…' : 'Loading…'}
    </div>
  )
}

export default function FaultInjectionTaskWizardPageSuspense() {
  return (
    <Suspense fallback={<WizardSuspenseFallback />}>
      <FaultInjectionTaskWizardPage />
    </Suspense>
  )
}
