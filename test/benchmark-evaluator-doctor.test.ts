import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const loadCommonJs = createRequire(__filename)
const { BenchmarkEvaluatorService } = loadCommonJs('../services/evaluator/src/service.cjs') as {
  BenchmarkEvaluatorService: new (options: Record<string, unknown>) => { createServer(): http.Server }
}
const { EvaluatorRegistry } = loadCommonJs('../services/evaluator/src/evaluator-registry.cjs') as {
  EvaluatorRegistry: new (evaluators: unknown[]) => unknown
}
const { doctor } = loadCommonJs('../services/evaluator/src/cli.cjs') as {
  doctor(options: Record<string, unknown>): Promise<{
    ok: boolean
    checks: { catalog: boolean }
    evaluators: Array<{ reason?: string }>
  }>
}

function listen(server: http.Server): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done, failed) => server.close((error) => error ? failed(error) : done())),
      })
    })
  })
}

test('Controller health stays healthy when one platform-specific Evaluator is not ready', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-doctor-'))
  const token = 'doctor-shared-token'
  const evaluator = {
    key: 'platform-specific',
    async checkReady() {
      return { ready: false, formalEligible: false, reason: 'unsupported on this architecture' }
    },
  }
  const service = new BenchmarkEvaluatorService({
    dataDir,
    token,
    registry: new EvaluatorRegistry([evaluator]),
    controllerProbe: async () => ({ dockerArch: 'arm64', dockerOSType: 'linux' }),
  })
  const listener = await listen(service.createServer())
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const health = await response.json()
    assert.equal(health.status, 'healthy')
    assert.equal(health.controller.ready, true)
    assert.equal(health.runtime.sourceDirty, false)
    assert.equal(health.evaluators[0].ready, false)

    const report = await doctor({ port: listener.port, token, timeoutMs: 1_000 })
    assert.equal(report.ok, true)
    assert.equal(report.checks.catalog, true)
    assert.equal(report.evaluators[0].reason, 'unsupported on this architecture')
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
