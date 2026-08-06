'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PageContainer, PageContent } from '@/components/shell/PageContainer'
import { HelpTip } from '@/components/fault-injection/HelpTip'
import { cn } from '@/lib/utils'

const FAULTS_HREF = '/agent-ras/fault-injection'
const TASKS_HREF = '/agent-ras/fault-injection/tasks'

const TITLE_TIP =
  '在真实 Agent 平台上注入内置故障模式，采集轨迹并由 Insight 评判是否发生与是否恢复。默认进入注入任务列表；右上角可切换到故障模式目录。'

export function FiPageShell({
  description,
  children,
  className,
  contentClassName,
}: {
  description?: string
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  const pathname = usePathname() || ''
  const onFaultsPage = pathname === FAULTS_HREF
  const navHref = onFaultsPage ? TASKS_HREF : FAULTS_HREF
  const navLabel = onFaultsPage ? '注入任务' : '故障模式'

  return (
    <PageContainer className={cn('min-h-0', className)}>
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="inline-flex items-center gap-1.5 text-lg font-semibold tracking-tight text-foreground">
            故障注入与评测
            <HelpTip widthClass="w-80">{TITLE_TIP}</HelpTip>
          </h1>
          {description ? (
            <p className="mt-1 text-sm text-foreground-muted">{description}</p>
          ) : null}
        </div>
        <Link
          href={navHref}
          className="shrink-0 rounded-md border border-border bg-card px-2.5 py-1 text-sm font-medium text-foreground-muted transition-colors hover:border-primary/40 hover:text-primary"
        >
          {navLabel}
        </Link>
      </div>
      <PageContent className={cn('flex min-h-0 flex-1 flex-col gap-4', contentClassName)}>
        {children}
      </PageContent>
    </PageContainer>
  )
}
