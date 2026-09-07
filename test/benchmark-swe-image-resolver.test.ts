import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { SweBenchImageResolver } = require('../benchmarks/swe-bench/evaluator/index.cjs') as {
  SweBenchImageResolver: new (
    runner: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>,
  ) => {
    resolve(jobImage: string, instanceId: string, workDir: string): Promise<Record<string, unknown>>
  }
}

const image = 'swebench/sweb.eval.x86_64.pallets_1776_flask-5014:latest'
const pinnedImage = `swebench/sweb.eval.x86_64.pallets_1776_flask-5014@sha256:${'a'.repeat(64)}`

function runnerWithImage(local: boolean) {
  const calls: Array<{ command: string; args: string[] }> = []
  let inspectCount = 0
  return {
    calls,
    runner: async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (args[0] === 'info') return { stdout: 'x86_64\n', stderr: '' }
      if (args[0] === 'pull') return { stdout: '', stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') {
        inspectCount += 1
        if (!local && inspectCount === 1) throw new Error('No such image')
        return { stdout: JSON.stringify([pinnedImage]), stderr: '' }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    },
  }
}

test('SWE-bench reuses a locally cached Case image without docker pull', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-image-local-'))
  const process = runnerWithImage(true)
  try {
    const result = await new SweBenchImageResolver(process.runner).resolve(
      image,
      'pallets__flask-5014',
      workDir,
    )
    assert.equal(result.pinnedImage, pinnedImage)
    assert.equal(process.calls.filter((call) => call.args[0] === 'pull').length, 0)
    assert.equal(process.calls.filter((call) => call.args[0] === 'image').length, 1)
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
})

test('SWE-bench pulls a Case image only when the local tag is missing', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-image-missing-'))
  const process = runnerWithImage(false)
  try {
    const result = await new SweBenchImageResolver(process.runner).resolve(
      image,
      'pallets__flask-5014',
      workDir,
    )
    assert.equal(result.pinnedImage, pinnedImage)
    assert.equal(process.calls.filter((call) => call.args[0] === 'pull').length, 1)
    assert.equal(process.calls.filter((call) => call.args[0] === 'image').length, 2)
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
})
