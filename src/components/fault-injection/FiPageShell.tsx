'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { PageContainer, PageContent } from '@/components/shell/PageContainer'
import { HelpTip } from '@/components/fault-injection/HelpTip'
import { useLocale } from '@/lib/client/locale-context'
import { cn } from '@/lib/utils'

const FAULTS_HREF = '/agent-ras/fault-injection/faults'
const TASKS_HREF = '/agent-ras/fault-injection/tasks'

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
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const pathname = usePathname() || ''
  const onFaultsPage = pathname === FAULTS_HREF || pathname.startsWith(`${FAULTS_HREF}/`)
  const navHref = onFaultsPage ? TASKS_HREF : FAULTS_HREF
  const navLabel = onFaultsPage
    ? zh
      ? '注入任务'
      : 'Injection tasks'
    : zh
      ? '故障目录'
      : 'Fault catalog'
  const titleTip = zh
    ? '在真实 Agent 平台上注入内置故障 skill，采集轨迹并由 Insight 评判是否发生与是否恢复。侧栏默认进入注入任务；右上角可切换到故障目录（勿与侧栏「可靠性能力」混淆）。'
    : 'Inject built-in fault skills on a real Agent platform, collect the trajectory, and let Insight judge occurrence and recovery. Sidebar defaults to the task list; use the top-right link for the FI fault catalog (distinct from sidebar Reliability Capabilities).'

  return (
    <PageContainer className={cn('min-h-0', className)}>
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="inline-flex items-center gap-1.5 text-lg font-semibold tracking-tight text-foreground">
            {zh ? '故障注入与评测' : 'Fault Injection & Eval'}
            <HelpTip widthClass="w-80">{titleTip}</HelpTip>
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
