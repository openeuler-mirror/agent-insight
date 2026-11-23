/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { evidenceSource } from '../../../packages/benchmark-protocol/artifact-path.cjs'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'

type EvidenceArtifact = { id: string; evaluationId: string; name: string; kind: string; mediaType: string; sha256: string; sizeBytes: number; storagePath: string }
function sha256(bytes: Uint8Array) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}` }

export async function readEvaluationEvidence(
  artifacts: readonly EvidenceArtifact[],
  dataRoot: string,
  runtimeFacts?: JsonValue,
): Promise<Array<{
  artifactId: string
  evaluationId: string
  name: string
  kind: string
  mediaType: string
  sha256: `sha256:${string}`
  sizeBytes: number
  jsonContent?: JsonValue
  source?: string
  jsonParseError?: string
}>> {
  const root = path.resolve(dataRoot)
  return Promise.all(artifacts.map(async (artifact) => {
    let jsonContent: JsonValue | undefined
    let jsonParseError: string | undefined
    const absolutePath = path.resolve(root, artifact.storagePath)
    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_PATH_INVALID', '评测证据存储路径不合法', 500)
    }
    let bytes: Buffer
    try { bytes = await fs.readFile(absolutePath) }
    catch {
      throw new BenchmarkProtocolError('EVALUATION_EVIDENCE_UNAVAILABLE', `评测证据 ${artifact.name} 原始文件不可读取`, 422, false, { phase: 'evidence-decoding' })
    }
    if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) {
      throw new BenchmarkProtocolError('EVALUATION_EVIDENCE_DIGEST_MISMATCH', `评测证据 ${artifact.name} 大小或摘要不匹配`, 422, false, { phase: 'evidence-decoding' })
    }
    if (artifact.mediaType.split(';', 1)[0].trim().toLowerCase() === 'application/json') {
      try { jsonContent = JSON.parse(bytes.toString('utf8')) as JsonValue }
      catch { jsonParseError = '附件不是有效 JSON，原始字节仍可下载；依赖此附件判分的 Adapter 必须拒绝缺失的结构化内容' }
    }
    return {
      artifactId: artifact.id,
      source: evidenceSource(runtimeFacts, artifact.id),
      evaluationId: artifact.evaluationId,
      name: artifact.name,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256 as `sha256:${string}`,
      sizeBytes: artifact.sizeBytes,
      ...(jsonContent === undefined ? {} : { jsonContent }),
      ...(jsonParseError ? { jsonParseError } : {}),
    }
  }))
}
