'use client'

import { Square, RotateCcw, Trash2, type LucideIcon } from 'lucide-react'
import { useLocale } from '@/lib/client/locale-context'
import { cn } from '@/lib/utils'

function IconAction({
  icon: Icon,
  title,
  onClick,
  disabled,
  danger,
}: {
  icon: LucideIcon
  title: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md border border-transparent text-foreground-muted transition-colors',
        'hover:bg-background-secondary hover:text-foreground',
        danger &&
          'hover:border-[var(--error-border)] hover:bg-[var(--error-subtle)] hover:text-[var(--error)]',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <Icon className="size-3.5" />
    </button>
  )
}

export function StopIconButton(props: { onClick: () => void; disabled?: boolean }) {
  const { locale } = useLocale()
  return <IconAction icon={Square} title={locale === 'zh' ? '停止' : 'Stop'} {...props} />
}

export function RerunIconButton(props: { onClick: () => void; disabled?: boolean }) {
  const { locale } = useLocale()
  return (
    <IconAction icon={RotateCcw} title={locale === 'zh' ? '再次运行' : 'Rerun'} {...props} />
  )
}

export function DeleteIconButton(props: { onClick: () => void; disabled?: boolean }) {
  const { locale } = useLocale()
  return (
    <IconAction icon={Trash2} title={locale === 'zh' ? '删除' : 'Delete'} danger {...props} />
  )
}

export function DangerOutlineButton({
  children,
  onClick,
  disabled,
  className,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center rounded-md border border-[var(--error-border)] bg-[var(--error-subtle)] px-3 text-xs font-medium text-[var(--error)] transition-colors hover:opacity-90 disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}
