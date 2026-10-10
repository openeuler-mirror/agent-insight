'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AppTopBar } from '@/components/shell/AppTopBar'
import { PageContainer } from '@/components/shell/PageContainer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/lib/auth/auth-context'
import { apiFetch } from '@/lib/client/api'

type Dataset = { id: string; name: string; benchmark?: { adapterKey: string; status: string } }
type Case = { id: string; input: string; values?: { externalCaseId?: string } }
type Upload = { file: File; caseId: string }

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  return btoa(binary)
}

export default function ImportPocPage() {
  const { user } = useAuth()
  const router = useRouter()
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [datasetId, setDatasetId] = useState('')
  const [cases, setCases] = useState<Case[]>([])
  const [uploads, setUploads] = useState<Upload[]>([])
  const [name, setName] = useState('ZSoft PoC 评测')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const idempotency = useRef('')
  const fileInput = useRef<HTMLInputElement>(null)
  const resetKey = () => { idempotency.current = '' }

  useEffect(() => {
    if (!user) return
    const controller = new AbortController()
    apiFetch(`/api/agent-datasets?user=${encodeURIComponent(user)}&view=summary`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('数据集加载失败'); return response.json() as Promise<Dataset[]> })
      .then((rows) => setDatasets(rows.filter((row) => row.benchmark?.adapterKey === 'zsoft-l1' && row.benchmark.status === 'ready')))
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '数据集加载失败') })
    return () => controller.abort()
  }, [user])

  useEffect(() => {
    if (!user || !datasetId) return
    const controller = new AbortController()
    apiFetch(`/api/agent-datasets/${encodeURIComponent(datasetId)}?user=${encodeURIComponent(user)}&view=items`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('题目加载失败'); return response.json() as Promise<{ cases: Case[] }> })
      .then((dataset) => { setCases(dataset.cases || []); setLoading(false) })
      .catch((cause) => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : '题目加载失败'); setLoading(false) } })
    return () => controller.abort()
  }, [datasetId, user])

  const submit = async () => {
    if (!user || !datasetId || !uploads.length || uploads.some((row) => !row.caseId)) return
    setBusy(true)
    setError('')
    if (!idempotency.current) idempotency.current = crypto.randomUUID()
    try {
      if (new Set(uploads.map((row) => row.caseId)).size !== uploads.length) throw new Error('每道题只能导入一个 PoC，请调整题目选择')
      const importedCases = await Promise.all(uploads.map(async (row) => ({ caseId: row.caseId, artifacts: [{ name: 'poc', contentBase64: await base64(row.file) }] })))
      const response = await apiFetch(`/api/benchmark/v1/submissions/import?user=${encodeURIComponent(user)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), datasetId, idempotencyKey: idempotency.current, cases: importedCases }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message || 'PoC 导入失败')
      router.push(`/experiments/${encodeURIComponent(body.experimentId)}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PoC 导入失败') }
    finally { setBusy(false) }
  }

  return <>
    <AppTopBar title="导入 PoC" />
    <PageContainer>
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        <p style={{ color: 'var(--foreground-muted)' }}>导入已有的单文件 PoC，由平台评测服务执行 ZSoft 官方判题。</p>
        <label className="flex flex-col gap-2">实验名称
          <Input value={name} maxLength={200} disabled={busy} onChange={(event) => { setName(event.target.value); resetKey() }} />
        </label>
        <label className="flex flex-col gap-2">数据集
          <select className="rounded-md border border-input bg-background p-2" value={datasetId} disabled={busy} onChange={(event) => {
            setDatasetId(event.target.value); setCases([]); setUploads([]); setLoading(Boolean(event.target.value)); setError(''); resetKey()
            if (fileInput.current) fileInput.current.value = ''
          }}>
            <option value="">请选择已安装的 ZSoft 数据集</option>
            {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-2">PoC 文件（最多 30 个，每个不超过 1 MiB）
          <Input ref={fileInput} type="file" multiple disabled={busy || loading || !cases.length} onChange={(event) => {
            resetKey(); setError('')
            const files = Array.from(event.target.files || [])
            if (files.length > 30 || files.some((file) => !file.size || file.size > 1048576)) {
              setUploads([]); setError('请上传 1～30 个非空 PoC 文件，每个不超过 1 MiB'); return
            }
            setUploads(files.map((file) => {
              const taskId = file.name.replace(/\.(py|c|bin|poc)$/i, '')
              return { file, caseId: cases.find((row) => row.values?.externalCaseId === taskId)?.id || (cases.length === 1 ? cases[0].id : '') }
            }))
          }} />
        </label>
        {uploads.length > 0 && <div className="flex flex-col gap-3">
          {uploads.map((upload, index) => <label key={`${upload.file.name}-${index}`} className="grid gap-2 sm:grid-cols-2">
            <span className="truncate" title={upload.file.name}>{upload.file.name}</span>
            <select aria-label={`${upload.file.name} 对应题目`} className="rounded-md border border-input bg-background p-2" value={upload.caseId} disabled={busy} onChange={(event) => {
              setUploads((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, caseId: event.target.value } : row)); resetKey()
            }}>
              <option value="">请选择对应题目</option>
              {cases.map((row) => <option key={row.id} value={row.id}>{row.values?.externalCaseId || row.input}</option>)}
            </select>
          </label>)}
        </div>}
        {error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}
        {!datasets.length && !error && <p style={{ color: 'var(--foreground-muted)' }}>尚无可用 ZSoft 数据集，请先安装已准备资产对应的数据集。</p>}
        <div className="flex gap-2">
          <Button disabled={busy || loading || !name.trim() || !uploads.length || uploads.some((row) => !row.caseId)} onClick={() => void submit()}>{busy ? '正在导入…' : '导入并评测'}</Button>
          <Button variant="outline" disabled={busy} onClick={() => router.push('/experiments')}>返回实验</Button>
        </div>
      </div>
    </PageContainer>
  </>
}
