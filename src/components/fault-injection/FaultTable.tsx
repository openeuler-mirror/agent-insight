'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  faultDisplayName,
  injectionMethodLabel,
  type FaultItem,
  type FaultSubmode,
} from '@/components/fault-injection/types'
import { SkillContentDialog } from '@/components/fault-injection/SkillContentDialog'
import { HelpTip } from '@/components/fault-injection/HelpTip'
import {
  TablePagination,
  clampPage,
  slicePage,
} from '@/components/fault-injection/TablePagination'
import { useLocale } from '@/lib/client/locale-context'
import { cn } from '@/lib/utils'

const FALLBACK_ROW_HEIGHT = 56
const MIN_PAGE_SIZE = 8

export type FaultTableRow = {
  key: string
  fault: FaultItem
  submode: FaultSubmode | null
}

export function expandFaultRows(faults: FaultItem[]): FaultTableRow[] {
  const rows: FaultTableRow[] = []
  for (const fault of faults) {
    const submodes = fault.submodes ?? []
    if (submodes.length > 1) {
      for (const submode of submodes) {
        rows.push({ key: `${fault.id}::${submode.id}`, fault, submode })
      }
      continue
    }
    rows.push({ key: fault.id, fault, submode: submodes[0] || null })
  }
  return rows
}

export function FaultTable({
  faults,
  loading = false,
  selectable = false,
  selectedKeys,
  onToggle,
  onToggleAll,
  className,
  compact = false,
}: {
  faults: FaultItem[]
  loading?: boolean
  selectable?: boolean
  selectedKeys?: Set<string>
  onToggle?: (row: FaultTableRow) => void
  onToggleAll?: (select: boolean) => void
  className?: string
  compact?: boolean
}) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const rows = useMemo(() => expandFaultRows(faults), [faults])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(compact ? 50 : MIN_PAGE_SIZE)
  const [skillFaultId, setSkillFaultId] = useState<string | null>(null)
  const tableAreaRef = useRef<HTMLDivElement>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const rowRef = useRef<HTMLTableRowElement>(null)
  const selectAllRef = useRef<HTMLInputElement>(null)

  const selectedCount = useMemo(() => {
    if (!selectedKeys || selectedKeys.size === 0) return 0
    return rows.reduce((n, row) => n + (selectedKeys.has(row.key) ? 1 : 0), 0)
  }, [rows, selectedKeys])
  const allSelected = rows.length > 0 && selectedCount === rows.length
  const someSelected = selectedCount > 0 && !allSelected

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected
    }
  }, [someSelected])

  useLayoutEffect(() => {
    if (compact) return
    const area = tableAreaRef.current
    if (!area) return
    const updatePageSize = () => {
      const areaHeight = area.clientHeight
      if (areaHeight < 80) {
        setPageSize(MIN_PAGE_SIZE)
        return
      }
      const headHeight = theadRef.current?.offsetHeight ?? 36
      const rowHeight = rowRef.current?.offsetHeight || FALLBACK_ROW_HEIGHT
      const available = Math.max(0, areaHeight - headHeight)
      const next = Math.max(MIN_PAGE_SIZE, Math.floor(available / rowHeight) || MIN_PAGE_SIZE)
      setPageSize((prev) => (prev === next ? prev : next))
    }
    updatePageSize()
    const observer = new ResizeObserver(updatePageSize)
    observer.observe(area)
    window.addEventListener('resize', updatePageSize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePageSize)
    }
  }, [rows.length, loading, compact])

  const safePage = clampPage(page, rows.length, pageSize)
  const pageItems = slicePage(rows, safePage, pageSize)

  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  const skillFault = skillFaultId ? faults.find((item) => item.id === skillFaultId) : null
  const needsPagination = rows.length > pageSize
  const secondaryLabel = (fault: FaultItem) =>
    zh ? fault.labelEn || fault.name : fault.labelZh || fault.name

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card',
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-3">
        <p className="text-xs text-foreground-muted">
          {zh ? `共 ${rows.length} 条` : `${rows.length} rows`}
        </p>
        <HelpTip>
          {selectable
            ? zh
              ? '勾选要注入的故障与子模式。同一故障的多个子模式会拆成多行，可分别勾选。'
              : 'Select faults and sub-modes to inject. Multi-submode faults split into rows you can pick separately.'
            : zh
              ? '内置故障 skill 目录。多子模式会拆成多行。点击「注入方式」查看 Skill 内容。创建注入任务请到「注入任务」页。'
              : 'Built-in fault skill catalog. Multi-submode faults split into rows. Click Injection method to view SKILL.md. Create runs from Injection tasks.'}
        </HelpTip>
      </div>

      <div ref={tableAreaRef} className="min-h-0 flex-1 overflow-hidden">
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-sm">
            <thead
              ref={theadRef}
              className="bg-background-secondary text-[11px] tracking-wide text-foreground-muted"
            >
              <tr>
                {selectable ? (
                  <th className="w-10 px-3 py-2.5">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      disabled={rows.length === 0 || !onToggleAll}
                      aria-label={zh ? '全选故障模式' : 'Select all fault modes'}
                      title={zh ? '全选 / 取消全选' : 'Select / clear all'}
                      onChange={() => onToggleAll?.(!allSelected)}
                    />
                  </th>
                ) : null}
                <th className="px-3 py-2.5 font-medium">{zh ? '故障模式' : 'Fault mode'}</th>
                <th className="min-w-[8rem] px-3 py-2.5 font-medium">
                  <span className="inline-flex items-center gap-1">
                    {zh ? '子模式' : 'Sub-mode'}
                    <HelpTip widthClass="w-64">
                      {zh
                        ? '来自 skill 场景定义。多子模式各占一行；无子模式时显示 --。'
                        : 'From skill scenario definitions. Each sub-mode is a row; shows -- when none.'}
                    </HelpTip>
                  </span>
                </th>
                <th className="whitespace-nowrap px-3 py-2.5 font-medium">
                  <span className="inline-flex items-center gap-1">
                    {zh ? '注入方式' : 'Injection method'}
                    <HelpTip widthClass="w-64">
                      {zh
                        ? 'Skill 注入 / 文件篡改 / 提示词修改 / 工具结果篡改 / 拦截改写等。点击按钮查看 SKILL.md。'
                        : 'Skill inject / file tamper / prompt edit / tool-result tamper / intercept rewrite, etc. Click to open SKILL.md.'}
                    </HelpTip>
                  </span>
                </th>
                {!compact ? (
                  <th className="px-3 py-2.5 font-medium">{zh ? '说明' : 'Description'}</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((row, index) => {
                const checked = selectedKeys?.has(row.key) ?? false
                return (
                  <tr
                    key={row.key}
                    ref={index === 0 ? rowRef : undefined}
                    className={cn(
                      'border-t border-border hover:bg-background-secondary/60',
                      checked && 'bg-[var(--primary-subtle)]/40',
                    )}
                  >
                    {selectable ? (
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggle?.(row)}
                        />
                      </td>
                    ) : null}
                    <td className="px-3 py-2.5 font-medium text-foreground">
                      {faultDisplayName(row.fault, locale)}
                      <span className="ml-1 font-mono text-xs font-normal text-foreground-muted">
                        ({secondaryLabel(row.fault)})
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-foreground-secondary">
                      {row.submode ? row.submode.name : '--'}
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => setSkillFaultId(row.fault.id)}
                        className="rounded border border-border px-2 py-1 text-xs text-primary hover:bg-[var(--primary-subtle)]"
                      >
                        {injectionMethodLabel(row.fault, locale)}
                      </button>
                    </td>
                    {!compact ? (
                      <td className="max-w-xl px-3 py-2.5 text-xs text-foreground-muted line-clamp-2">
                        {row.submode?.description || row.fault.description}
                      </td>
                    ) : null}
                  </tr>
                )
              })}
              {!rows.length && (
                <tr>
                  <td
                    colSpan={selectable ? (compact ? 4 : 5) : compact ? 3 : 4}
                    className="px-4 py-10 text-center text-sm text-foreground-muted"
                  >
                    {loading
                      ? zh
                        ? '加载中…'
                        : 'Loading…'
                      : zh
                        ? '暂无故障模式'
                        : 'No fault modes'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {needsPagination ? (
        <TablePagination page={safePage} pageSize={pageSize} total={rows.length} onPageChange={setPage} />
      ) : null}

      <SkillContentDialog
        faultId={skillFaultId}
        faultLabel={skillFault ? faultDisplayName(skillFault, locale) : undefined}
        open={Boolean(skillFaultId)}
        onOpenChange={(next) => {
          if (!next) setSkillFaultId(null)
        }}
      />
    </div>
  )
}
