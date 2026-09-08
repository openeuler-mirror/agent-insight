'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')

class PlatformClientError extends Error {
  constructor(code, message, status = 502, retryable = true) {
    super(message)
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

class AgentInsightPlatformClient {
  constructor(token, fetchImpl = fetch, authMode = 'token') {
    if (!['token', 'none'].includes(authMode)) throw new Error('EVALUATOR_AUTH_MODE must be token or none')
    if (authMode === 'token' && !token) throw new Error('EVALUATOR_PLATFORM_TOKEN is required')
    this.token = token
    this.fetch = fetchImpl
    this.authMode = authMode
  }

  authorizationHeaders() {
    return this.authMode === 'token' ? { authorization: `Bearer ${this.token}` } : {}
  }

  async responseJson(response, code) {
    const text = (await response.text()).slice(0, 64 * 1024)
    let body = {}
    try { body = text ? JSON.parse(text) : {} } catch {}
    if (!response.ok) {
      throw new PlatformClientError(
        body?.error?.code || code,
        body?.error?.message || `Agent Insight 返回 HTTP ${response.status}`,
        response.status,
        response.status >= 500,
      )
    }
    return body
  }

  async downloadArtifact(request, descriptor) {
    const response = await this.fetch(
      `${request.platformBaseUrl}/api/benchmark/v1/artifacts/${encodeURIComponent(descriptor.artifactId)}/content`,
      {
        method: 'GET',
        redirect: 'error',
        headers: {
          ...this.authorizationHeaders(),
          'x-agent-insight-evaluation-id': request.runId,
        },
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!response.ok) await this.responseJson(response, 'ARTIFACT_DOWNLOAD_FAILED')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== descriptor.sizeBytes || sha256(bytes) !== descriptor.sha256) {
      throw new PlatformClientError(
        'ARTIFACT_CONTENT_MISMATCH',
        `Artifact ${descriptor.name} 的大小或摘要不匹配`,
        422,
        false,
      )
    }
    return bytes
  }

  async progress(request, event) {
    const response = await this.fetch(`${request.callbackBaseUrl}/progress`, {
      method: 'POST',
      redirect: 'error',
      headers: { ...this.authorizationHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    })
    return this.responseJson(response, 'PROGRESS_CALLBACK_FAILED')
  }

  async uploadEvidence(request, evidence) {
    const bytes = await fs.readFile(evidence.path)
    const digest = sha256(bytes)
    const form = new FormData()
    form.set('metadata', JSON.stringify({
      evaluationId: request.runId,
      name: evidence.name,
      kind: evidence.kind,
      mediaType: evidence.mediaType,
      sha256: digest,
    }))
    form.set('file', new Blob([bytes], { type: evidence.mediaType }), evidence.name)
    const response = await this.fetch(`${request.callbackBaseUrl}/artifacts`, {
      method: 'POST',
      redirect: 'error',
      headers: this.authorizationHeaders(),
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const body = await this.responseJson(response, 'EVIDENCE_UPLOAD_FAILED')
    if (!body.artifactId || body.sha256 !== digest || body.size !== bytes.length) {
      throw new PlatformClientError('EVIDENCE_UPLOAD_RESPONSE_INVALID', '证据上传响应不完整')
    }
    return body
  }

  async complete(request, completion) {
    const response = await this.fetch(`${request.callbackBaseUrl}/complete`, {
      method: 'POST',
      redirect: 'error',
      headers: { ...this.authorizationHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(completion),
      signal: AbortSignal.timeout(30_000),
    })
    return this.responseJson(response, 'COMPLETION_CALLBACK_FAILED')
  }
}

module.exports = { AgentInsightPlatformClient, PlatformClientError, sha256 }
