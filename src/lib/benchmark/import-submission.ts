import { z } from 'zod'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'

export const MAX_IMPORTED_SUBMISSION_BYTES = 32 * 1024 * 1024
export const MAX_IMPORT_BODY_BYTES = Math.ceil(MAX_IMPORTED_SUBMISSION_BYTES / 3) * 4 + 128 * 1024

const ImportSchema = z.object({
  name: z.string().trim().min(1).max(200),
  datasetId: z.string().min(1).max(200),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._-]{8,128}$/),
  cases: z.array(z.object({
    caseId: z.string().min(1).max(200),
    artifacts: z.array(z.object({
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      contentBase64: z.string().min(4).max(MAX_IMPORT_BODY_BYTES),
    }).strict()).min(1).max(8),
  }).strict()).min(1).max(30),
}).strict()

export type ImportedSubmission = {
  name: string; datasetId: string; idempotencyKey: string
  cases: Array<{ caseId: string; artifacts: Array<{ name: string; bytes: Buffer }> }>
}

export function decodeImportedSubmission(value: unknown): ImportedSubmission {
  const parsed = ImportSchema.safeParse(value)
  if (!parsed.success) throw new BenchmarkProtocolError('SUBMISSION_IMPORT_INVALID', '导入参数不合法：需要数据集、Case、PoC 和幂等键', 400)
  const seen = new Set<string>()
  let total = 0
  const cases = parsed.data.cases.map((row) => {
    if (seen.has(row.caseId)) throw new BenchmarkProtocolError('CASE_SELECTION_INVALID', '导入包含重复 Case', 400)
    seen.add(row.caseId)
    const names = new Set<string>()
    const artifacts = row.artifacts.map((artifact) => {
      if (names.has(artifact.name)) throw new BenchmarkProtocolError('ARTIFACT_NAME_DUPLICATE', 'Artifact 名称重复', 400)
      names.add(artifact.name)
      if (artifact.contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(artifact.contentBase64)) {
        throw new BenchmarkProtocolError('ARTIFACT_ENCODING_INVALID', 'PoC 必须使用标准 Base64 编码', 400)
      }
      const bytes = Buffer.from(artifact.contentBase64, 'base64')
      if (!bytes.length || bytes.toString('base64') !== artifact.contentBase64) throw new BenchmarkProtocolError('ARTIFACT_ENCODING_INVALID', 'PoC Base64 编码不合法', 400)
      total += bytes.length
      if (total > MAX_IMPORTED_SUBMISSION_BYTES) throw new BenchmarkProtocolError('SUBMISSION_IMPORT_TOO_LARGE', '单次导入总大小不得超过 32 MiB', 413)
      return { name: artifact.name, bytes }
    })
    return { caseId: row.caseId, artifacts }
  })
  return { name: parsed.data.name, datasetId: parsed.data.datasetId, idempotencyKey: parsed.data.idempotencyKey, cases }
}

export async function readBoundedImportJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new BenchmarkProtocolError('CONTENT_TYPE_INVALID', '需要 application/json 请求', 415)
  if (Number(request.headers.get('content-length')) > MAX_IMPORT_BODY_BYTES) throw new BenchmarkProtocolError('SUBMISSION_IMPORT_TOO_LARGE', '导入请求过大', 413)
  if (!request.body) throw new BenchmarkProtocolError('SUBMISSION_IMPORT_INVALID', '请求体为空', 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_IMPORT_BODY_BYTES) {
        await reader.cancel()
        throw new BenchmarkProtocolError('SUBMISSION_IMPORT_TOO_LARGE', '导入请求过大', 413)
      }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new BenchmarkProtocolError('SUBMISSION_IMPORT_INVALID', '请求体不是有效 JSON', 400) }
}
