'use strict'

const fs = require('node:fs')
const path = require('node:path')
const C = require('./common.cjs')

function snapshot(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.some(file => typeof file !== 'string' || !path.isAbsolute(file))) C.fail('复用需要非空的绝对路径输入清单')
  if (new Set(inputs).size !== inputs.length) C.fail('复用输入不能重复')
  return inputs.slice().sort().map(file => ({ path: C.real(file), digest: C.fileHash(file) }))
}

function inspectRecord(record, directory, identity, inputs) {
  if (record.schemaVersion !== 'benchmark-onboarding-recorded-operation/v1' || record.state !== 'completed') C.fail('原始操作未完成；先查询旧任务与清理，不能自动重提')
  if (C.canonical(record.identity) !== C.canonical(identity) || C.canonical(record.inputs) !== C.canonical(inputs)) C.fail('操作身份或输入已变化，不能复用；核对旧任务后为受影响操作使用新记录')
  if (record.valueDigest !== C.hash(C.canonical(record.value))) C.fail('原始结果摘要不匹配')
  if (!Array.isArray(record.files) || !record.files.length) C.fail('原始操作缺少证据文件')
  for (const file of record.files) {
    const resolved = path.resolve(directory, file.name)
    if (!C.inside(path.join(directory, 'raw'), resolved) || !C.inside(directory, C.real(resolved)) || C.fileHash(resolved) !== file.digest) C.fail('原始证据缺失、越界或摘要不匹配')
  }
}

async function recordedOperation({ directory, identity, inputs, execute, validate }) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || ['project', 'benchmarkKey', 'operation'].some(key => typeof identity[key] !== 'string' || !identity[key].trim())) C.fail('操作身份需要 project、benchmarkKey 和 operation')
  if (typeof execute !== 'function' || typeof validate !== 'function') C.fail('需要 execute 与 validate 回调')
  C.outsideSkill(directory)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  directory = C.real(directory)
  const manifest = path.join(directory, 'record.json')
  return C.withLock(directory, async () => {
    const before = snapshot(inputs)
    const reused = fs.existsSync(manifest)
    let record
    if (reused) {
      record = C.readJson(manifest)
      inspectRecord(record, directory, identity, before)
    } else {
      // A crash or unknown submission must leave a durable barrier to automatic retries.
      record = { schemaVersion: 'benchmark-onboarding-recorded-operation/v1', state: 'pending', identity, inputs: before, createdAt: new Date().toISOString() }
      C.atomicJson(manifest, record)
      const result = await execute()
      if (!result || result.value === undefined || !Array.isArray(result.files) || !result.files.length) C.fail('execute 必须返回原始 value 与非空 files')
      if (C.canonical(before) !== C.canonical(snapshot(inputs))) C.fail('执行期间操作输入变化，保留 pending 记录并核对任务')
      record.value = JSON.parse(JSON.stringify(result.value))
      record.valueDigest = C.hash(C.canonical(record.value))
      record.files = result.files.map((file, index) => {
        if (typeof file !== 'string' || !path.isAbsolute(file)) C.fail('原始证据必须使用绝对路径')
        const digest = C.fileHash(file)
        const name = `raw/${index}-${path.basename(file)}`
        const target = path.join(directory, name)
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(target, 0o600)
        if (C.fileHash(target) !== digest) C.fail('复制期间原始证据发生变化')
        return { name, digest }
      })
      // Save completed collection before validating/converting so a validator fix can replay it.
      record.state = 'completed'
      C.atomicJson(manifest, record)
    }
    const digest = C.fileHash(manifest)
    const files = record.files.map(file => path.join(directory, file.name))
    if (await validate({ value: structuredClone(record.value), files: [...files], reused }) !== true) C.fail('原始操作的当前有效性核对未通过')
    if (C.fileHash(manifest) !== digest || C.canonical(before) !== C.canonical(snapshot(inputs))) C.fail('核对期间记录或操作输入发生变化')
    inspectRecord(C.readJson(manifest), directory, identity, before)
    return { value: structuredClone(record.value), files, reused, manifest, digest }
  })
}

function copyRecordedEvidence(record, attempt) {
  C.outsideSkill(attempt)
  if (C.fileHash(record.manifest) !== record.digest) C.fail('待导出的原始记录摘要不匹配')
  const directory = path.dirname(C.real(record.manifest))
  const stored = C.readJson(record.manifest)
  inspectRecord(stored, directory, stored.identity, snapshot(stored.inputs.map(input => input.path)))
  const prefix = `recorded-${record.digest.slice(7, 23)}`
  const target = path.join(attempt, prefix)
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  const sources = [{ name: 'record.json', path: record.manifest, digest: record.digest }, ...stored.files.map(file => ({ ...file, path: path.join(directory, file.name) }))]
  for (const file of sources) {
    const destination = path.join(target, file.name)
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    fs.copyFileSync(file.path, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o600)
    if (C.fileHash(destination) !== file.digest) C.fail('导出期间原始证据发生变化')
  }
  return { evidence: sources.map(file => `${prefix}/${file.name}`), files: stored.files.map(file => `${prefix}/${file.name}`) }
}

module.exports = { recordedOperation, copyRecordedEvidence }
