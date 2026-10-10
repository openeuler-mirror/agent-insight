import { NextResponse } from 'next/server'

import { reliabilityErrorResponse } from '@/lib/reliability/api-error'
import { authenticateDevice } from '@/lib/reliability/client-registry'
import { claimNextCommand } from '@/lib/reliability/command-bus'

export const dynamic = 'force-dynamic'

const POLL_STEP_MS = 500
const MAX_WAIT_SEC = 30

/** IF-N07：WSS 不可用时的长轮询兜底。单次等待不超过 30 秒。 */
export async function GET(req: Request) {
  try {
    const { clientId } = await authenticateDevice(req)
    const url = new URL(req.url)
    const waitSeconds = Math.min(
      MAX_WAIT_SEC,
      Math.max(0, Number(url.searchParams.get('waitSeconds')) || 25),
    )
    const deadline = Date.now() + waitSeconds * 1000

    for (;;) {
      const frame = await claimNextCommand(clientId)
      if (frame) return NextResponse.json(frame)
      if (Date.now() >= deadline) break
      if (req.signal?.aborted) break
      await new Promise((resolve) => setTimeout(resolve, POLL_STEP_MS))
    }
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return reliabilityErrorResponse(error, 'reliability/commands/next')
  }
}
