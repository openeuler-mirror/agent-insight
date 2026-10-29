'use strict'

const fs = require('node:fs')
const path = require('node:path')
const C = require('./common.cjs')

function checkedPath(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) C.fail('协议来源路径必须是包内或仓库内的相对路径')
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) return null
  if (!C.inside(root, C.real(file))) C.fail(`协议来源越出根目录：${relative}`)
  return file
}

function compareProtocol(repoPath, snapshot, packageRoot = C.skillRoot) {
  if (snapshot.schemaVersion !== 'benchmark-protocol-snapshot/v1' || !snapshot.snapshotVersion || !/^[0-9a-f]{40}$/.test(snapshot.source?.revision || '') || !snapshot.files?.length || !snapshot.bundledFiles?.length) C.fail('协议来源清单不完整')
  for (const group of [snapshot.files, snapshot.bundledFiles]) {
    if (new Set(group.map(item => item.path)).size !== group.length) C.fail('协议来源清单包含重复路径')
    for (const item of group) if (!/^sha256:[0-9a-f]{64}$/.test(item.sha256 || '')) C.fail('协议来源摘要不合法')
  }
  const root = C.real(packageRoot)
  for (const item of snapshot.bundledFiles) {
    const file = checkedPath(root, item.path)
    if (!file || C.fileHash(file) !== item.sha256) C.fail(`包内协议说明或模板摘要不匹配：${item.path}`)
  }
  const repo = C.real(repoPath)
  if (C.real(C.git(repo, ['rev-parse', '--show-toplevel'])) !== repo) C.fail('协议核对需要目标 Git 工作副本根目录')
  const files = snapshot.files.map(item => {
    const file = checkedPath(repo, item.path)
    const actual = file ? C.fileHash(file) : null
    return { path: item.path, role: item.role, expected: item.sha256, actual, status: !actual ? 'missing' : actual === item.sha256 ? 'match' : 'changed' }
  })
  return {
    schemaVersion: 'benchmark-protocol-check/v1',
    status: files.every(item => item.status === 'match') ? 'match' : 'review_required',
    snapshotVersion: snapshot.snapshotVersion,
    source: snapshot.source,
    target: { repo, head: C.git(repo, ['rev-parse', 'HEAD']) },
    capabilities: 'not_checked',
    files,
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) C.fail('用法：node protocol-check.cjs <目标仓库根目录>')
    const snapshot = C.readJson(path.join(C.skillRoot, 'references/benchmark-protocol.sources.json'))
    const result = compareProtocol(process.argv[2], snapshot)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.status === 'match' ? 0 : 2
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'error', reason: error.message })}\n`)
    process.exitCode = 1
  }
}

module.exports = { compareProtocol }
