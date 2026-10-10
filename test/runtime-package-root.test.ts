import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { runtimePackageRoot } from '../src/lib/runtime/package-root'

test('runtime package root does not follow standalone cwd when explicitly configured', () => {
  const previous = process.env.AGENT_INSIGHT_PACKAGE_ROOT
  try {
    process.env.AGENT_INSIGHT_PACKAGE_ROOT = path.join(process.cwd(), 'package-root')
    assert.equal(runtimePackageRoot(), path.resolve(process.cwd(), 'package-root'))
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_PACKAGE_ROOT
    else process.env.AGENT_INSIGHT_PACKAGE_ROOT = previous
  }
})
