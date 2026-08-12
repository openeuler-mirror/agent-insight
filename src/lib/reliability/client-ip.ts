/** Prefer non-loopback host/connection IPs for client display. */

export function isLoopbackIp(ip: string | null | undefined): boolean {
  const value = String(ip || '').trim().toLowerCase()
  if (!value) return true
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value === 'localhost') return true
  if (value.startsWith('127.')) return true
  return false
}

export function clientIpFromRequest(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const real = req.headers.get('x-real-ip')?.trim()
  if (real) return real
  const cf = req.headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  return null
}

/** Display order: non-loopback reported → non-loopback observed → reported → observed → null. */
export function pickDisplayClientIp(input: {
  reportedIp?: string | null
  observedIp?: string | null
}): string | null {
  const reported = String(input.reportedIp || '').trim() || null
  const observed = String(input.observedIp || '').trim() || null
  if (reported && !isLoopbackIp(reported)) return reported
  if (observed && !isLoopbackIp(observed)) return observed
  return reported || observed || null
}
