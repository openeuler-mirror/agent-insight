'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { HelpTip } from '@/components/fault-injection/HelpTip'
import { MarkdownText } from '@/components/thread/markdown-text'
import { cn } from '@/lib/utils'

type ViewMode = 'preview' | 'source'

export function SkillContentDialog({
  faultId,
  faultLabel,
  open,
  onOpenChange,
}: {
  faultId: string | null
  faultLabel?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [content, setContent] = useState<string>('')
  const [skillName, setSkillName] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<ViewMode>('preview')

  useEffect(() => {
    if (!open || !faultId) {
      setContent('')
      setError(null)
      setMode('preview')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/fault-injection/faults/${encodeURIComponent(faultId)}/skill`)
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'load skill failed')
        if (!cancelled) {
          setContent(String(data.content || ''))
          setSkillName(String(data.skillName || data.skill_name || data.name || faultId))
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, faultId])

  const previewBody = useMemo(() => {
    if (!content) return ''
    const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
    return (match ? match[1] : content).trim()
  }, [content])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="inline-flex items-center gap-1.5 text-[13px]">
                Skill 注入内容
                <HelpTip>
                  经平台安装后加载该 Skill 进行故障注入。预览为 Markdown 渲染；可切换查看原文。
                </HelpTip>
              </DialogTitle>
              <p className="mt-1 truncate text-xs text-foreground-muted">
                {faultLabel || faultId}
                {skillName ? ` · ${skillName}` : ''}
              </p>
            </div>
            {content ? (
              <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
                <button
                  type="button"
                  className={cn(
                    'h-7 rounded px-2.5',
                    mode === 'preview'
                      ? 'bg-[var(--primary-subtle)] text-primary'
                      : 'text-foreground-muted hover:text-foreground',
                  )}
                  onClick={() => setMode('preview')}
                >
                  预览
                </button>
                <button
                  type="button"
                  className={cn(
                    'h-7 rounded px-2.5',
                    mode === 'source'
                      ? 'bg-[var(--primary-subtle)] text-primary'
                      : 'text-foreground-muted hover:text-foreground',
                  )}
                  onClick={() => setMode('source')}
                >
                  原文
                </button>
              </div>
            ) : null}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? <p className="text-sm text-foreground-muted">加载中…</p> : null}
          {error ? (
            <p className="whitespace-pre-wrap text-sm text-[var(--error)]">{error}</p>
          ) : null}
          {content && mode === 'preview' ? (
            <div className="prose prose-sm max-w-none text-foreground">
              <MarkdownText>{previewBody}</MarkdownText>
            </div>
          ) : null}
          {content && mode === 'source' ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background-secondary p-3 font-mono text-xs leading-relaxed">
              {content}
            </pre>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
