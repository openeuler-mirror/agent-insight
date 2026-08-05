'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  {
    href: '/agent-ras/fault-injection',
    label: '故障模式',
    match: (p: string) => p === '/agent-ras/fault-injection',
  },
  {
    href: '/agent-ras/fault-injection/tasks',
    label: '注入任务',
    match: (p: string) =>
      p.startsWith('/agent-ras/fault-injection/tasks') ||
      p.startsWith('/agent-ras/fault-injection/runs'),
  },
]

export function FiSubNav() {
  const pathname = usePathname() || ''
  return (
    <div className="flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const active = tab.match(pathname)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-foreground-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
