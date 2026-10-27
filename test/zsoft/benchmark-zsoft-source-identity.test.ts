import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadZsoftCases } from '../../benchmarks/zsoft-l1/dataset'

test('ZSoft platform and Python hash identical mixed-case paths and Unicode/numeric object keys', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zsoft-identity-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const task = 'linux-rxrpc-024-fixture'
  const taskRoot = path.join(root, 'tasks', task)
  await fs.mkdir(path.join(taskRoot, 'public/repo-vul'), { recursive: true })
  const manifest = { task_id: task, title: '合成内核题', description: 'Synthetic source only', tags: ['kernel'], submission: { max_bytes: 128 },
    metadata: { '10': 'ten', '2': 'two', Z: false, a: true, '😀': ['Unicode', 42], '\uE000': null } }
  await fs.writeFile(path.join(taskRoot, 'task.json'), JSON.stringify(manifest))
  for (const filename of ['README.md', 'repo-vul/Kconfig', 'repo-vul/Makefile', 'repo-vul/a.c', 'repo-vul/a-b.c', 'repo-vul/a_b.c']) {
    await fs.writeFile(path.join(taskRoot, 'public', filename), `source ${filename}`)
  }
  const pythonDigest = () => execFileSync('python3', ['-c', `
import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / 'benchmarks/zsoft-l1/evaluator'))
from assets import source_task_digest
print(source_task_digest(Path(sys.argv[1]), sys.argv[2]))
`, root, task], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim()
  const [loaded] = await loadZsoftCases(root)
  assert.equal(loaded.private.sourceTaskDigest, pythonDigest())
  const reversed = Object.fromEntries(Object.entries(manifest).reverse())
  await fs.writeFile(path.join(taskRoot, 'task.json'), JSON.stringify(reversed, null, 2))
  assert.equal((await loadZsoftCases(root))[0].private.sourceTaskDigest, loaded.private.sourceTaskDigest)
  assert.equal(pythonDigest(), loaded.private.sourceTaskDigest)
  await fs.writeFile(path.join(taskRoot, 'public/repo-vul/a.c'), 'modified source')
  const changed = (await loadZsoftCases(root))[0].private.sourceTaskDigest
  assert.notEqual(changed, loaded.private.sourceTaskDigest)
  assert.equal(changed, pythonDigest())
})
