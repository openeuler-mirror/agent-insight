'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

export function CopyableId({
  value,
  className,
}: {
  value: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <span className={cn('inline-flex max-w-full items-center gap-1', className)}>
      <code className="truncate font-mono text-xs text-foreground-secondary">{value}</code>
      <button
        type="button"
        title="复制"
        aria-label="复制"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-foreground-muted hover:bg-background-secondary hover:text-foreground"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          } catch {
            /* ignore */
          }
        }}
      >
        {copied ? <Check className="size-3.5 text-[var(--success)]" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  )
}
