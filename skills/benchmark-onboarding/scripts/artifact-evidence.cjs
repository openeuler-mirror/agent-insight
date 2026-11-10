'use strict'

const fs = require('node:fs')
const path = require('node:path')
const C = require('./common.cjs')

const sources = new Set(['official-file', 'official-return', 'runtime-output', 'platform'])

function inspectArtifacts(value, expected, context) {
  const records = value.facts?.artifactChecks
  if (!Array.isArray(records) || records.length !== expected.length) C.fail('评测产物核对记录缺失或范围不匹配')
  const root = C.real(context.attempt), declared = new Set(value.evidence)
  const cache = new Map()
  const read = name => {
    if (cache.has(name)) return cache.get(name)
    if (typeof name !== 'string' || !declared.has(name)) C.fail(`产物核对引用未声明的证据文件：${name}`)
    const checked = context.verifiedEvidence?.get(name)
    const file = checked?.file || C.real(path.resolve(root, name))
    const stat = checked?.stat || fs.statSync(file), digest = checked?.digest || C.fileHash(file)
    if (!C.inside(root, file) || !stat.isFile() || digest !== value.evidenceDigests?.[name]) C.fail(`产物证据缺失、越界或摘要不匹配：${name}`)
    const result = { file, digest, size: stat.size, identity: `${stat.dev}:${stat.ino}` }
    cache.set(name, result)
    return result
  }
  const checkFiles = (files, platform) => {
    if (!Array.isArray(files)) C.fail('原始输出或平台附件清单缺失')
    const names = new Set(), ids = new Set()
    return new Map(files.map(item => {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || !sources.has(item.source) || names.has(item.name)) C.fail('产物名称重复、缺失或来源类型不合法')
      names.add(item.name)
      const { file, digest, size, identity } = read(item.file)
      if (platform) {
        if (typeof item.artifactId !== 'string' || !item.artifactId.trim() || ids.has(item.artifactId)) C.fail('平台 Artifact ID 缺失或重复')
        if (item.sha256 !== digest || item.sizeBytes !== size) C.fail(`平台下载文件与返回摘要/大小不一致：${item.name}`)
        ids.add(item.artifactId)
      }
      return [item.name, { ...item, file, digest, size, identity }]
    }))
  }
  const remaining = new Set(expected.map(item => item.sampleId || item.caseId))
  let count = 0
  for (const record of records) {
    const key = record.sampleId || record.caseId
    const item = expected.find(item => (item.sampleId || item.caseId) === key)
    if (!item || !remaining.delete(key) || record.caseId !== item.caseId || record.submissionDigest !== item.submissionDigest
      || typeof record.evaluationId !== 'string' || !record.evaluationId.trim() || (item.evaluationId && record.evaluationId !== item.evaluationId)) C.fail('产物与 Case、提交或评测轮次关联不匹配')
    for (const field of ['sourceEvidence', 'platformEvidence', 'mappingEvidence']) read(record[field])
    const originals = checkFiles(record.outputs, false), attachments = checkFiles(record.attachments, true)
    if (!['files', 'return', 'none'].includes(record.outputMode)) C.fail('官方产物形式必须是 files、return 或 none')
    if (record.outputMode === 'none') {
      if (originals.size || typeof record.absenceReason !== 'string' || !record.absenceReason.trim()) C.fail('无原生输出须有实现依据与本次记录，不能隐藏缺失产物')
    } else if (!originals.size) C.fail('已声明的官方文件或返回记录不能为空')
    for (const [name, original] of originals) {
      if (original.source !== (record.outputMode === 'files' ? 'official-file' : 'official-return')) C.fail('来源须匹配官方产物形式，接入层或平台补充信息不能冒充官方原始输出')
      const uploaded = attachments.get(name)
      if (!uploaded) C.fail(`平台缺少原始产物或擅自改名：${name}`)
      if (uploaded.source !== original.source || uploaded.digest !== original.digest || uploaded.size !== original.size) C.fail(`原始内容被替换、来源不符或摘要代替原件：${name}`)
      if (uploaded.file === original.file || uploaded.identity === original.identity) C.fail('原始产物与平台下载不能引用同一个文件冒充对照')
      count++
    }
    for (const [name, attachment] of attachments) {
      if (!originals.has(name) && !['runtime-output', 'platform'].includes(attachment.source)) C.fail(`平台存在未核对来源的评测附件：${name}`)
    }
  }
  const presentation = value.facts?.artifactPresentation
  if (!presentation || !['pass', 'not_checked'].includes(presentation.status)) C.fail('须如实记录评测附件页面验证范围')
  if (presentation.status === 'pass') read(presentation.evidence)
  else if (typeof presentation.reason !== 'string' || !presentation.reason.trim()) C.fail('未做页面验证须说明范围或原因')
  return { checkedEvaluations: records.length, checkedOutputs: count, presentation: presentation.status }
}

module.exports = { inspectArtifacts }
