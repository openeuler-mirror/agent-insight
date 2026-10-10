import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { decodeImportedSubmission, readBoundedImportJson } from '@/lib/benchmark/import-submission'
import { importBenchmarkSubmission } from '@/lib/benchmark/import-submission-service'
import { BenchmarkProtocolError } from '../../../../../../../packages/benchmark-protocol/src/errors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const url = new URL(request.url)
    const { username } = await resolveUser(request, url.searchParams.get('user'))
    if (!username) throw new BenchmarkProtocolError('USER_REQUIRED', '缺少用户身份', 401)
    const input = decodeImportedSubmission(await readBoundedImportJson(request))
    const host = request.headers.get('x-forwarded-host') || url.host
    const protocol = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')
    const prefix = String(process.env.NEXT_PUBLIC_URL_PREFIX || '').replace(/^\/?/, '/').replace(/\/$/, '')
    const result = await importBenchmarkSubmission({ ...input, user: username, callbackOrigin: `${protocol}://${host}${prefix}` })
    return NextResponse.json(result, { status: result.reused ? 200 : 201 })
  } catch (error) { return benchmarkErrorResponse(error, 'benchmark/submissions/import') }
}
