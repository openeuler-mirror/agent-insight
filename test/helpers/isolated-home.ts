import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'

export function assertTemporaryHome(home: string): void {
  const temporary = fs.realpathSync(os.tmpdir())
  let existing = path.resolve(home)
  while (!fs.existsSync(existing)) existing = path.dirname(existing)
  const resolved = path.resolve(fs.realpathSync(existing), path.relative(existing, path.resolve(home)))
  const relative = path.relative(temporary, resolved)
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'Installer tests must use a directory inside the system temporary directory')
}

const privateEnvironment = /^(?:AGENT_INSIGHT_|DATABASE_URL$|OTEL_|QWEN_TELEMETRY_|PI_CODING_AGENT_DIR$|CODEX_HOME$|XDG_)/
const credentialEnvironment = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

export function isolatedHomeEnv(home: string, overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  assertTemporaryHome(home)
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (privateEnvironment.test(key) || credentialEnvironment.test(key)) delete env[key]
  }
  Object.assign(env, overrides, {
    HOME: home,
    USERPROFILE: home,
    AGENT_INSIGHT_USER_HOME: home,
    AGENT_INSIGHT_HOME: path.join(home, '.agent-insight'),
    DATABASE_URL: `file:${path.join(home, 'test.db')}`,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  })
  delete env.AGENT_INSIGHT_DATA_DIR
  return env
}

export function activateIsolatedHome(home: string): () => void {
  const previous = { ...process.env }
  const isolated = isolatedHomeEnv(home)
  const keys = new Set([...Object.keys(previous), ...Object.keys(isolated)])
  for (const key of keys) {
    if (isolated[key] === undefined) delete process.env[key]
    else process.env[key] = isolated[key]
  }
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

export function useIsolatedHome(t: Pick<TestContext, 'after'>, home: string): void {
  t.after(activateIsolatedHome(home))
}
