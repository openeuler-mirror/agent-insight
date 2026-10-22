#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const benchmarkKey = process.argv[2]
let imagePrefix = process.env.EVALUATOR_RUNTIME_IMAGE_PREFIX || ''
let push = false
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--push') push = true
  else if (process.argv[i] === '--image-prefix' && process.argv[i + 1]) imagePrefix = process.argv[++i]
  else throw new Error(`Unknown argument: ${process.argv[i]}`)
}
if (!benchmarkKey || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(benchmarkKey)) {
  throw new Error('usage: node scripts/benchmark/build-evaluator-runtime.cjs <benchmark-key> [--image-prefix registry/namespace] [--push]')
}

require('./generate-catalog.cjs').generate(root)
delete require.cache[require.resolve('../../generated/benchmark-catalog/evaluators.cjs')]
const { generatedEvaluatorDescriptors } = require('../../generated/benchmark-catalog/evaluators.cjs')
const descriptor = generatedEvaluatorDescriptors.find((item) => item.benchmarkKey === benchmarkKey)
if (!descriptor) throw new Error(`Benchmark 不存在：${benchmarkKey}`)
if (descriptor.runtime !== 'oci-container' || !descriptor.image) {
  throw new Error(`Benchmark 未声明 OCI Evaluator Runtime：${benchmarkKey}`)
}
const image = require('../../services/evaluator/src/runtime-image.cjs').runtimeDescriptor(descriptor, imagePrefix).image

const dockerfile = descriptor.dockerfile
if (!fs.existsSync(dockerfile)) throw new Error(`Evaluator Runtime Dockerfile 不存在：${dockerfile}`)
const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
if (revision.status !== 0) throw new Error('无法读取 Git revision')
const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
if (dirty.status !== 0) throw new Error('无法读取 Git 状态')
const args = [
  'build', '--file', dockerfile,
  '--build-arg', `EVALUATOR_SOURCE_REVISION=${revision.stdout.trim()}`,
  '--build-arg', `EVALUATOR_SOURCE_DIRTY=${Boolean(dirty.stdout.trim())}`,
  '--build-arg', `EVALUATOR_ARTIFACT_DIGEST=${descriptor.artifactDigest}`,
  '--tag', image,
  root,
]
const result = spawnSync('docker', args, { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
if (push) {
  const published = spawnSync('docker', ['push', image], { stdio: 'inherit' })
  if (published.error) throw published.error
  if (published.status !== 0) process.exit(published.status || 1)
}
process.stdout.write(`${image}\n`)
