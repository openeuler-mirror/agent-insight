'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FiPageShell } from '@/components/fault-injection/FiPageShell'
import { FaultTable } from '@/components/fault-injection/FaultTable'
import { normalizeFault, type FaultItem } from '@/components/fault-injection/types'

export default function FaultInjectionFaultsPage() {
  const [faults, setFaults] = useState<FaultItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/fault-injection/faults')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'load faults failed')
      setFaults((data.faults || []).map((row: Record<string, unknown>) => normalizeFault(row)))
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <FiPageShell title="故障注入" contentClassName="min-h-[70vh]">
      <FaultTable faults={faults} loading={loading} />
    </FiPageShell>
  )
}
