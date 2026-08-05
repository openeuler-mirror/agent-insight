'use client'

import type { ReactNode } from 'react'
import { PageContainer, PageContent } from '@/components/shell/PageContainer'
import { FiSubNav } from '@/components/fault-injection/FiSubNav'
import { cn } from '@/lib/utils'

export function FiPageShell({
  title,
  description,
  children,
  className,
  hideSubNav = false,
  contentClassName,
}: {
  title?: string
  description?: string
  children: ReactNode
  className?: string
  hideSubNav?: boolean
  contentClassName?: string
}) {
  return (
    <PageContainer className={cn('min-h-0', className)}>
      {(title || description) && (
        <div className="mb-3 shrink-0">
          {title ? <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1> : null}
          {description ? (
            <p className="mt-1 text-sm text-foreground-muted">{description}</p>
          ) : null}
        </div>
      )}
      <PageContent className={cn('flex min-h-0 flex-1 flex-col gap-4', contentClassName)}>
        {!hideSubNav ? <FiSubNav /> : null}
        {children}
      </PageContent>
    </PageContainer>
  )
}
