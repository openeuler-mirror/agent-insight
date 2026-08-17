import { isIP } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'

/** Prefer non-loopback host/connection IPs for client display. */

export type TrustedClientIpHeader =
  | 'x-forwarded-for'
  | 'x-real-ip'
  | 'cf-connecting-ip'

export type ClientIpRequestOptions = {
  trustedHeader?: TrustedClientIpHeader | null
  allowDirectConnection?: boolean
  clientHostName?: string | null
}

function configuredTrustedHeader(): TrustedClientIpHeader | null {
  const value = String(process.env.AGENT_INSIGHT_TRUSTED_PROXY_HEADER || '')
    .trim()
    .toLowerCase()
  if (
    value === 'x-forwarded-for' ||
    value === 'x-real-ip' ||
    value === 'cf-connecting-ip'
  ) {
    return value
  }
  return null
}

function normalizeIpLiteral(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let ip = value.trim().replace(/^"|"$/g, '')
  if (!ip) return null
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']')
    if (end > 0) ip = ip.slice(1, end)
  }
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) ip = mapped[1]
  return isIP(ip) ? ip.toLowerCase() : null
}

function isPublicIpv4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

export function normalizePublicIp(value: unknown): string | null {
  const ip = normalizeIpLiteral(value)
  if (!ip) return null
  if (isIP(ip) === 4) return isPublicIpv4(ip) ? ip : null

  if (ip === '::' || ip === '::1' || ip.startsWith('2001:db8:')) return null
  const firstHextet = Number.parseInt(ip.split(':', 1)[0], 16)
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff ? ip : null
}

export function isLoopbackIp(ip: string | null | undefined): boolean {
  const value = String(ip || '').trim().toLowerCase()
  if (!value) return true
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value === 'localhost') return true
  if (value.startsWith('127.')) return true
  return false
}

function isCurrentServerAddress(value: unknown): boolean {
  const candidate = normalizeIpLiteral(value)
  if (!candidate) return false
  if (isLoopbackIp(candidate)) return true
  return Object.values(networkInterfaces()).some((entries) =>
    entries?.some((entry) => normalizeIpLiteral(entry.address) === candidate),
  )
}

export function clientIpFromRequest(
  req: Request,
  options: ClientIpRequestOptions = {},
): string | null {
  const trustedHeader = options.trustedHeader === undefined
    ? configuredTrustedHeader()
    : options.trustedHeader
  if (trustedHeader) {
    const raw = req.headers.get(trustedHeader)
    if (raw) {
      const candidate = trustedHeader === 'x-forwarded-for'
        ? raw.split(',')[0]?.trim()
        : raw.trim()
      const publicIp = normalizePublicIp(candidate)
      if (publicIp) return publicIp
    }
    if (!options.allowDirectConnection) return null
  }

  if (!options.allowDirectConnection) return null

  // Next.js direct server fills x-forwarded-for from socket.remoteAddress when
  // the uploader did not send that header. Only authenticated OpenCode uploads
  // enable this path; legacy uploads cannot opt themselves in.
  const directPeer = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const publicPeer = normalizePublicIp(directPeer)
  if (publicPeer) return publicPeer

  // When OpenCode runs on the Agent Insight server itself, the TCP peer is often
  // loopback/private. The local peer address and authenticated uploader hostname
  // must both match this server before using the public IP it connected to.
  const reportedHostName = String(options.clientHostName || '').trim().toLowerCase()
  if (
    !isCurrentServerAddress(directPeer) ||
    !reportedHostName ||
    reportedHostName !== hostname().trim().toLowerCase()
  ) {
    return null
  }
  const hostHeader = req.headers.get('host')
  if (hostHeader) {
    try {
      const publicHost = normalizePublicIp(new URL('http://' + hostHeader).hostname)
      if (publicHost) return publicHost
    } catch {}
  }
  try {
    return normalizePublicIp(new URL(req.url).hostname)
  } catch {
    return null
  }
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
