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
const proxyImage = `docker.1ms.run/${image}`
const pinnedImage = `swebench/sweb.eval.x86_64.pallets_1776_flask-5014@sha256:${'a'.repeat(64)}`
const localImageId = `sha256:${'b'.repeat(64)}`

process.env.SWE_BENCH_IMAGE_PROXY_PREFIX = 'docker.1ms.run'

function runnerWithImage(local: boolean, proxyUnavailable = false) {
  const calls: Array<{ command: string; args: string[] }> = []
  let inspectCount = 0
  return {
    calls,
    runner: async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (args[0] === 'info') return { stdout: 'x86_64\n', stderr: '' }
      if (args[0] === 'pull') {
        if (proxyUnavailable && args[1] === proxyImage) throw new Error('proxy unavailable')
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'tag') return { stdout: '', stderr: '' }
      if (args[0] === 'image' && args[1] === 'inspect') {
        inspectCount += 1
        if (!local && inspectCount === 1) throw new Error('No such image')
        return { stdout: `${JSON.stringify([pinnedImage])}|${localImageId}`, stderr: '' }
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

test('SWE-bench pins an offline-loaded Case image by immutable image ID when RepoDigests are absent', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-image-offline-'))
  const process = runnerWithImage(true)
  process.runner = async (command: string, args: string[]) => {
    process.calls.push({ command, args })
    if (args[0] === 'info') return { stdout: 'x86_64\n', stderr: '' }
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { stdout: `[]|${localImageId}`, stderr: '' }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
  try {
    const result = await new SweBenchImageResolver(process.runner).resolve(
      image,
      'pallets__flask-5014',
      workDir,
    )
    assert.equal(result.pinnedImage, localImageId)
    assert.equal(process.calls.some((call) => call.args[0] === 'pull'), false)
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
})

test('SWE-bench pulls a missing Case image through the configured proxy and restores the official tag', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-image-missing-'))
  const process = runnerWithImage(false)
  try {
    const result = await new SweBenchImageResolver(process.runner).resolve(
      image,
      'pallets__flask-5014',
      workDir,
    )
    assert.equal(result.pinnedImage, pinnedImage)
    assert.deepEqual(process.calls.find((call) => call.args[0] === 'pull')?.args, ['pull', proxyImage])
    assert.deepEqual(process.calls.find((call) => call.args[0] === 'tag')?.args, ['tag', proxyImage, image])
    assert.equal(process.calls.filter((call) => call.args[0] === 'image').length, 2)
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
})

test('SWE-bench uses Docker daemon registry mirrors when no proxy prefix is configured', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-image-daemon-mirror-'))
  const runnerProcess = runnerWithImage(false)
  const configuredProxy = process.env.SWE_BENCH_IMAGE_PROXY_PREFIX
  delete process.env.SWE_BENCH_IMAGE_PROXY_PREFIX
  try {
    const result = await new SweBenchImageResolver(runnerProcess.runner).resolve(
      image,
      'pallets__flask-5014',
      workDir,
    )
    assert.equal(result.imageProxyPrefix, null)
    assert.deepEqual(runnerProcess.calls.find((call) => call.args[0] === 'pull')?.args, ['pull', image])
    assert.equal(runnerProcess.calls.some((call) => call.args[0] === 'tag'), false)
  } finally {
    process.env.SWE_BENCH_IMAGE_PROXY_PREFIX = configuredProxy
    await fsp.rm(workDir, { recursive: true, force: true })
  }
})

test('SWE-bench falls back to the official image when the configured proxy is unavailable', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-image-fallback-'))
  const process = runnerWithImage(false, true)
  try {
    await new SweBenchImageResolver(process.runner).resolve(
      image,
      'pallets__flask-5014',
      workDir,
    )
    assert.deepEqual(
      process.calls.filter((call) => call.args[0] === 'pull').map((call) => call.args),
      [['pull', proxyImage], ['pull', image]],
    )
    assert.equal(process.calls.some((call) => call.args[0] === 'tag'), false)
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
})
