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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

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
const { formatDoctorOutput } = loadCommonJs('../services/evaluator/src/cli.cjs') as {
  formatDoctorOutput(output: Record<string, unknown>, summary?: boolean): string
}

test('startup Doctor prints a compact count while manual Doctor retains diagnostic JSON', () => {
  const report = { ok: true, checks: { http: true, dockerSocket: true, journal: true, catalog: true },
    runtime: { image: 'controller:long-digest' }, evaluators: [
      { key: 'swe-bench', ready: true, runtimeFacts: { artifactDigest: 'sha256:long-digest' } },
      { key: 'zsoft-l1', ready: true },
    ] }
  assert.equal(formatDoctorOutput(report, true), 'Doctor 检查通过：评测器就绪 2/2。')
  assert.deepEqual(JSON.parse(formatDoctorOutput(report)), report)
})

test('Doctor summary preserves failed checks and evaluator readiness reasons', () => {
  const output = formatDoctorOutput({ ok: false, checks: { http: true, dockerSocket: false },
    reason: 'Docker unavailable', evaluators: [{ key: 'zsoft-l1', ready: false, reason: 'assets unavailable' }] }, true)
  assert.match(output, /Doctor 检查失败/)
  assert.match(output, /Controller：Docker unavailable/)
  assert.match(output, /检查未通过：dockerSocket/)
  assert.match(output, /zsoft-l1 未就绪：assets unavailable/)
})

test('Doctor wrapper forwards summary only when requested and prints captured diagnostics on failure', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluator-doctor-output-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'evaluator.env')
  fs.writeFileSync(config, '', { mode: 0o600 })
  const script = path.resolve(__dirname, '../scripts/evaluator-doctor.sh')
  for (const args of ['', '--summary']) {
    const result = spawnSync('bash', ['-c', `
docker() {
  printf 'CALL %s\\n' "$*" >&2
  case "$*" in
    *State.Running*) printf 'true\\n' ;;
    *cli.cjs*) printf 'Doctor captured failure\\n'; return 1 ;;
  esac
}
export -f docker
bash "$1" --config "$2" ${args}
`, 'test', script, config], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Doctor captured failure/)
    assert.match(result.stderr, /容器内 Doctor 未通过/)
    if (args) assert.match(result.stderr, /cli\.cjs doctor --summary/)
    else assert.doesNotMatch(result.stderr, /--summary/)
  }
})

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
  const evaluator = {
    key: 'platform-specific',
    async checkReady() {
      return { ready: false, formalEligible: false, reason: 'unsupported on this architecture' }
    },
  }
  const service = new BenchmarkEvaluatorService({
    dataDir,
    registry: new EvaluatorRegistry([evaluator]),
    controllerProbe: async () => ({ dockerArch: 'arm64', dockerOSType: 'linux' }),
  })
  const listener = await listen(service.createServer())
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/health`)
    const health = await response.json()
    assert.equal(health.status, 'healthy')
    assert.equal(health.controller.ready, true)
    assert.equal(health.runtime.sourceDirty, false)
    assert.equal(health.evaluators[0].ready, false)

    const report = await doctor({ port: listener.port, timeoutMs: 1_000 })
    assert.equal(report.ok, true)
    assert.equal(report.checks.catalog, true)
    assert.equal(report.evaluators[0].reason, 'unsupported on this architecture')
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Controller and Doctor require no application credential', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-evaluator-doctor-none-'))
  const evaluator = {
    key: 'no-auth-evaluator',
    async checkReady() { return { ready: true, formalEligible: true } },
  }
  const service = new BenchmarkEvaluatorService({
    dataDir,
    registry: new EvaluatorRegistry([evaluator]),
    controllerProbe: async () => ({ dockerArch: 'x86_64', dockerOSType: 'linux' }),
  })
  const listener = await listen(service.createServer())
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/health`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).runtime.authMode, undefined)

    const report = await doctor({ port: listener.port, timeoutMs: 1_000 })
    assert.equal(report.ok, true)
  } finally {
    await listener.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
