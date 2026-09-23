import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const { verifyStandalone } = createRequire(import.meta.url)('../scripts/verify-standalone.cjs')

test('standalone preflight rejects missing pages and client reference manifests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-check-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = {
    'server.js': '', '.next/BUILD_ID': 'test', '.next/required-server-files.json': '{}',
    '.next/server/app-paths-manifest.json': JSON.stringify({ '/(app)/dataset/page': 'app/(app)/dataset/page.js', '/api/ping/route': 'app/api/ping/route.js' }),
    '.next/server/pages-manifest.json': JSON.stringify({ '/500': 'pages/500.html' }),
    '.next/server/app/(app)/dataset/page.js': '',
    '.next/server/app/(app)/dataset/page_client-reference-manifest.js': '',
    '.next/server/app/api/ping/route.js': '', '.next/server/pages/500.html': '',
  }
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    fs.writeFileSync(path.join(root, relative), content)
  }
  assert.doesNotThrow(() => verifyStandalone(root))
  for (const relative of Object.keys(files)) {
    fs.unlinkSync(path.join(root, relative))
    assert.throws(() => verifyStandalone(root), /Incomplete standalone build/)
    fs.writeFileSync(path.join(root, relative), files[relative as keyof typeof files])
  }
})

test('startup readiness rejects HTTP 500 instead of accepting an open port', () => {
  const script = fs.readFileSync('scripts/start.sh', 'utf8')
  assert.ok(script.includes('node scripts/verify-standalone.cjs "$STANDALONE_DIR"'))
  const readiness = script.slice(script.indexOf('READY=0'))
  for (const route of ['dataset', 'fault']) assert.ok(readiness.includes(`http://127.0.0.1:$PORT/${route}`))
  assert.match(readiness, /curl --noproxy '\*' -fsS/)
})
