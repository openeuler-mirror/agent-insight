import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const REPO = path.resolve(import.meta.dirname, '..')
const AGENT_RAS = path.join(REPO, 'agent_ras')

/** Paths that must never reappear as committed developer machine leaks. */
const FORBIDDEN = [
  /\/home\/iceory\b/,
  /\/Users\/iceory\b/,
  /miniconda3\/lib\/libpython/,
]

const SCAN_ROOTS = [
  path.join(AGENT_RAS, 'config'),
  path.join(AGENT_RAS, 'scripts'),
  path.join(AGENT_RAS, 'platform_adapter', 'opencode', 'INSTALL.md'),
]

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const st = fs.statSync(root)
  if (st.isFile()) return [root]
  const out: string[] = []
  for (const name of fs.readdirSync(root)) {
    if (name === 'node_modules' || name === '.python-packages' || name === '__pycache__') {
      continue
    }
    out.push(...walkFiles(path.join(root, name)))
  }
  return out
}

test('agent_ras config/scripts/INSTALL must not contain developer home paths', () => {
  const files = SCAN_ROOTS.flatMap(walkFiles).filter((f) => {
    const base = path.basename(f)
    if (base.endsWith('.pyc')) return false
    return true
  })
  assert.ok(files.length > 0, 'expected files to scan')

  const hits: string[] = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const re of FORBIDDEN) {
      if (re.test(text)) {
        hits.push(`${path.relative(REPO, file)} matches ${re}`)
      }
    }
  }
  assert.deepEqual(hits, [], hits.join('\n'))
})
