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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalidCallbackResponse(code, message) {
  return new PlatformClientError(code, message, 502, true)
}

function assertProgressAcknowledgement(body) {
  if (!isPlainObject(body) || body.accepted !== true || body.desiredState !== 'continue') {
    throw invalidCallbackResponse(
      'PROGRESS_CALLBACK_RESPONSE_INVALID',
      'Agent Insight 进度回调响应不符合协议',
    )
  }
  return body
}

function assertCompletionAcknowledgement(body, completion) {
  const expectedNormalizedStatus = completion.status === 'failed' ? 'failed' : 'done'
  if (
    !isPlainObject(body)
    || body.accepted !== true
    || body.evaluationStatus !== completion.status
    || body.normalizationStatus !== 'completed'
    || !isPlainObject(body.normalizedResult)
    || body.normalizedResult.status !== expectedNormalizedStatus
  ) {
    throw invalidCallbackResponse(
      'COMPLETION_CALLBACK_RESPONSE_INVALID',
      'Agent Insight 评测完成回调响应不符合协议',
    )
  }
  return body
}

class AgentInsightPlatformClient {
  constructor(token, fetchImpl = fetch, authMode = 'token', platformBaseUrl = '') {
    if (!['token', 'none'].includes(authMode)) throw new Error('EVALUATOR_AUTH_MODE must be token or none')
    if (authMode === 'token' && !token) throw new Error('EVALUATOR_PLATFORM_TOKEN is required')
    this.token = token
    this.fetch = fetchImpl
    this.authMode = authMode
    this.platformBaseUrl = String(platformBaseUrl || '').replace(/\/$/, '')
    if (this.platformBaseUrl) {
      let configured
      try { configured = new URL(this.platformBaseUrl) } catch { throw new Error('EVALUATOR_AGENT_INSIGHT_BASE_URL is invalid') }
      if (
        !['http:', 'https:'].includes(configured.protocol)
        || configured.username
        || configured.password
        || configured.search
        || configured.hash
      ) {
        throw new Error('EVALUATOR_AGENT_INSIGHT_BASE_URL must be an HTTP(S) URL without credentials, query or fragment')
      }
    }
  }

  requestPlatformBaseUrl(request) {
    return this.platformBaseUrl || String(request.platformBaseUrl || '').replace(/\/$/, '')
  }

  evaluationCallbackBaseUrl(request) {
    if (!this.platformBaseUrl) return String(request.callbackBaseUrl || '').replace(/\/$/, '')
    return `${this.requestPlatformBaseUrl(request)}/api/benchmark/v1/evaluations/${encodeURIComponent(request.runId)}`
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
      `${this.requestPlatformBaseUrl(request)}/api/benchmark/v1/artifacts/${encodeURIComponent(descriptor.artifactId)}/content`,
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
    const response = await this.fetch(`${this.evaluationCallbackBaseUrl(request)}/progress`, {
      method: 'POST',
      redirect: 'error',
      headers: { ...this.authorizationHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    })
    return assertProgressAcknowledgement(
      await this.responseJson(response, 'PROGRESS_CALLBACK_FAILED'),
    )
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
    const response = await this.fetch(`${this.evaluationCallbackBaseUrl(request)}/artifacts`, {
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
    const response = await this.fetch(`${this.evaluationCallbackBaseUrl(request)}/complete`, {
      method: 'POST',
      redirect: 'error',
      headers: { ...this.authorizationHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(completion),
      signal: AbortSignal.timeout(30_000),
    })
    return assertCompletionAcknowledgement(
      await this.responseJson(response, 'COMPLETION_CALLBACK_FAILED'),
      completion,
    )
  }
}

module.exports = {
  AgentInsightPlatformClient,
  PlatformClientError,
  assertCompletionAcknowledgement,
  assertProgressAcknowledgement,
  sha256,
}
