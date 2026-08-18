import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(__dirname, '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('experiment schema keeps comparison groups and generated trace attempts', () => {
  const schema = read('prisma/schema.prisma')

  assert.match(schema, /groups\s+ExperimentGroup\[\]/)
  assert.match(schema, /traceAttempts\s+ExperimentTraceAttempt\[\]/)
  assert.match(schema, /groupId\s+String\?/)
  assert.match(schema, /faultInjectionType\s+String\?/)
  assert.match(schema, /model ExperimentTraceAttempt/)
})

test('experiment UI and run route keep comparison and generated trace flows separate', () => {
  const page = read('src/app/(main)/experiments/new/page.tsx')
  const runRoute = read('src/app/api/experiments/[id]/run/route.ts')

  assert.match(page, /useState<'single' \| 'llm'>\('single'\)/)
  assert.match(page, /useState<'existing' \| 'generate'>\('existing'\)/)
  assert.match(page, /expType === 'single' && traceMode === 'generate'/)
  assert.match(runRoute, /startComparisonRun/)
  assert.match(runRoute, /generateExperimentTraces/)
  assert.ok(
    runRoute.indexOf("exp.type === 'llm'") < runRoute.indexOf('const wantGenerate'),
    'comparison dispatch must happen before generated-trace orchestration',
  )
})

test('setup and CLI retain upstream collectors and reliability installers', () => {
  const autoSetup = read('src/app/api/ingest/setup/auto/route.ts')
  const setup = read('src/app/api/ingest/setup/route.ts')
  const cli = read('bin/cli.js')

  for (const framework of ['llamaindex', 'pi-agent', 'qwencode', 'xiaoo', 'codex']) {
    assert.match(autoSetup, new RegExp(`['\"]${framework}['\"]`))
  }
  assert.match(autoSetup, /install_agent_insight_ras/)
  assert.match(setup, /install_agent_insight_client/)
  assert.match(cli, /install \[--frameworks <comma-list>\]/)
  assert.match(cli, /install-ras/)
  assert.match(cli, /install-fault-injection/)
})
