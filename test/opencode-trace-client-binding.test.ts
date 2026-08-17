import assert from 'node:assert/strict'
import test from 'node:test'

import { POST } from '@/app/api/ingest/upload/route'
import {
  createInstallToken,
  registerClient,
} from '@/lib/reliability/client-registry'
import { prismaRaw } from '@/lib/storage/prisma'

const TEST_USER = `trace-client-binding-${process.pid}`

test('OpenCode Trace only binds a verified client and preserves its first IP snapshot', async () => {
  const firstTaskId = `trace-client-first-${process.pid}-${Date.now()}`
  const legacyTaskId = `trace-client-legacy-${process.pid}-${Date.now()}`
  const mismatchTaskId = `trace-client-mismatch-${process.pid}-${Date.now()}`
  const previousTrustedHeader = process.env.AGENT_INSIGHT_TRUSTED_PROXY_HEADER
  let clientId: string | null = null

  process.env.AGENT_INSIGHT_TRUSTED_PROXY_HEADER = 'x-forwarded-for'
  try {
    const { installToken } = await createInstallToken({
      user: TEST_USER,
      expiresInSeconds: 600,
    })
    const registered = await registerClient({
      installToken,
      hostname: 'registered-host',
      reportedIp: '10.20.30.40',
    })
    clientId = registered.clientId

    const upload = (
      taskId: string,
      payload: Record<string, unknown>,
      forwardedFor: string,
    ) => POST(new Request('https://insight.test/api/ingest/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${registered.deviceCredential}`,
        'content-type': 'application/json',
        'x-agent-insight-client-id': registered.clientId,
        'x-forwarded-for': forwardedFor,
      },
      body: JSON.stringify({
        task_id: taskId,
        framework: 'opencode',
        interactions: [],
        ...payload,
      }),
    }))

    const first = await upload(
      firstTaskId,
      {
        client_id: registered.clientId,
        host: { hostname: 'host-a', reported_ip: '10.0.0.8' },
      },
      '8.8.8.8, 10.0.0.2',
    )
    assert.equal(first.status, 200)

    const retry = await upload(
      firstTaskId,
      {
        client_id: registered.clientId,
        host: { hostname: 'host-b', reported_ip: '10.0.0.9' },
      },
      '1.1.1.1',
    )
    assert.equal(retry.status, 200)

    const stored = await prismaRaw.execution.findUnique({
      where: { id: firstTaskId },
      select: {
        clientId: true,
        hostIp: true,
        hostName: true,
        observedIp: true,
        user: true,
      },
    })
    assert.deepEqual(stored, {
      clientId: registered.clientId,
      hostIp: '10.0.0.8',
      hostName: 'host-a',
      observedIp: '8.8.8.8',
      user: TEST_USER,
    })

    const legacy = await POST(new Request('https://insight.test/api/ingest/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '1.1.1.1',
      },
      body: JSON.stringify({
        task_id: legacyTaskId,
        framework: 'opencode',
        user: TEST_USER,
        client_id: 'cli_unverified-12345678',
        interactions: [],
      }),
    }))
    assert.equal(legacy.status, 200)
    const legacyStored = await prismaRaw.execution.findUnique({
      where: { id: legacyTaskId },
      select: { clientId: true, observedIp: true },
    })
    assert.deepEqual(legacyStored, { clientId: null, observedIp: '1.1.1.1' })

    const mismatch = await upload(
      mismatchTaskId,
      { client_id: 'cli_different-12345678' },
      '8.8.4.4',
    )
    assert.equal(mismatch.status, 403)
    assert.equal(
      await prismaRaw.execution.count({ where: { id: mismatchTaskId } }),
      0,
    )
  } finally {
    if (previousTrustedHeader === undefined) {
      delete process.env.AGENT_INSIGHT_TRUSTED_PROXY_HEADER
    } else {
      process.env.AGENT_INSIGHT_TRUSTED_PROXY_HEADER = previousTrustedHeader
    }
    await prismaRaw.execution.deleteMany({
      where: { id: { in: [firstTaskId, legacyTaskId, mismatchTaskId] } },
    })
    if (clientId) {
      await prismaRaw.reliabilityClientCredential.deleteMany({ where: { clientId } })
      await prismaRaw.reliabilityClient.deleteMany({ where: { clientId } })
    }
    await prismaRaw.reliabilityInstallToken.deleteMany({ where: { user: TEST_USER } })
  }
})
