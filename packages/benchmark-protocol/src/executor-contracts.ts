import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { AgentTaskEnvelope } from './contracts'
import { BenchmarkProtocolError } from './errors'

export type BenchmarkExecutionRequest = {
  runId: string
  requestDigest: `sha256:${string}`
  task: AgentTaskEnvelope
  callbackBaseUrl: string
  timeoutSeconds: number
}

export type BenchmarkExecutionAccepted = {
  runId: string
  status: 'accepted'
  requestDigest: `sha256:${string}`
}

export type BenchmarkExecutionProgress = {
  kind: 'execution'
  stage: 'preparing' | 'agent_running' | 'collecting' | 'uploading' | 'cleaning'
  progress?: { message?: string; elapsedSeconds?: number }
  occurredAt: string
}

export type BenchmarkExecutionCompletion = {
  kind: 'execution'
  status: 'succeeded' | 'failed'
  artifacts: Array<{ artifactId: string; name: string; sha256: `sha256:${string}` }>
  runFacts: Record<string, unknown>
  cleanup: Record<string, unknown>
  error?: { code: string; message: string }
}

type DispatchTokenPayload = {
  aud: 'benchmark-executor'
  purpose: 'execute'
  clientId: string
  runId: string
  requestDigest: string
  expiresAt: number
}

type HealthTokenPayload = {
  aud: 'benchmark-executor'
  purpose: 'health'
  clientId: string
  expiresAt: number
}

export function deviceCredentialHash(deviceCredential: string): string {
  return createHash('sha256').update(deviceCredential).digest('hex')
}

function hmacKey(credentialHash: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(credentialHash)) {
    throw new BenchmarkProtocolError('DISPATCH_CREDENTIAL_INVALID', '执行器凭据摘要不合法', 500)
  }
  return Buffer.from(credentialHash, 'hex')
}

function signToken(payload: DispatchTokenPayload | HealthTokenPayload, credentialHash: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', hmacKey(credentialHash))
    .update(encoded)
    .digest('base64url')
  return `${encoded}.${signature}`
}

export function createBenchmarkDispatchToken(input: {
  clientId: string
  runId: string
  requestDigest: string
  credentialHash: string
  expiresAt?: number
}): string {
  const payload: DispatchTokenPayload = {
    aud: 'benchmark-executor',
    purpose: 'execute',
    clientId: input.clientId,
    runId: input.runId,
    requestDigest: input.requestDigest,
    expiresAt: input.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
  }
  return signToken(payload, input.credentialHash)
}

export function createBenchmarkHealthToken(input: {
  clientId: string
  credentialHash: string
  expiresAt?: number
}): string {
  return signToken({
    aud: 'benchmark-executor',
    purpose: 'health',
    clientId: input.clientId,
    expiresAt: input.expiresAt ?? Math.floor(Date.now() / 1000) + 60,
  }, input.credentialHash)
}

export function verifyBenchmarkDispatchToken(input: {
  token: string
  clientId: string
  runId: string
  requestDigest: string
  credentialHash: string
  nowSeconds?: number
}): DispatchTokenPayload {
  const [encoded, signature, extra] = input.token.split('.')
  if (!encoded || !signature || extra) {
    throw new BenchmarkProtocolError('DISPATCH_UNAUTHORIZED', '执行器下发 token 不合法', 401)
  }
  const expected = createHmac('sha256', hmacKey(input.credentialHash))
    .update(encoded)
    .digest()
  let actual: Buffer
  let payload: DispatchTokenPayload
  try {
    actual = Buffer.from(signature, 'base64url')
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as DispatchTokenPayload
  } catch {
    throw new BenchmarkProtocolError('DISPATCH_UNAUTHORIZED', '执行器下发 token 不合法', 401)
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new BenchmarkProtocolError('DISPATCH_UNAUTHORIZED', '执行器下发 token 签名无效', 401)
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (
    payload.aud !== 'benchmark-executor'
    || payload.purpose !== 'execute'
    || payload.clientId !== input.clientId
    || payload.runId !== input.runId
    || payload.requestDigest !== input.requestDigest
    || !Number.isInteger(payload.expiresAt)
    || payload.expiresAt < now
    || payload.expiresAt > now + 600
  ) {
    throw new BenchmarkProtocolError('DISPATCH_FORBIDDEN', '执行器下发 token 与当前任务不匹配', 403)
  }
  return payload
}
