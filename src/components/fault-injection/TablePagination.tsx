'use client'

import { useLocale } from '@/lib/client/locale-context'

export function slicePage<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize
  return items.slice(start, start + pageSize)
}

export function clampPage(page: number, total: number, pageSize: number): number {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  return Math.min(Math.max(1, page), totalPages)
}

export function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  if (total === 0) return null

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
      <p className="text-xs text-foreground-muted">
        {zh
          ? `第 ${start}–${end} 条，共 ${total} 条`
          : `${start}–${end} of ${total}`}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={zh ? '上一页' : 'Previous page'}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded border border-border px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {zh ? '上一页' : 'Prev'}
        </button>
        <span className="min-w-[4.5rem] text-center text-xs tabular-nums text-foreground-muted">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          aria-label={zh ? '下一页' : 'Next page'}
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded border border-border px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {zh ? '下一页' : 'Next'}
        </button>
      </div>
    </div>
  )
}
