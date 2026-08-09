import { redirect } from 'next/navigation'

/** Canonical FI entry is the task list; catalog lives at `/faults`. */
export default function FaultInjectionIndexPage() {
  redirect('/agent-ras/fault-injection/tasks')
}
