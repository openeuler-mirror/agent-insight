import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import ts from "typescript"

import nextConfig from "../next.config"

test("Next build uses an app-only TypeScript project", () => {
  const tsconfigPath = nextConfig.typescript?.tsconfigPath
  assert.equal(tsconfigPath, "tsconfig.next.json")

  const absoluteConfigPath = path.join(process.cwd(), tsconfigPath)
  const configFile = ts.readConfigFile(absoluteConfigPath, ts.sys.readFile)
  assert.equal(configFile.error, undefined)

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd())
  assert.deepEqual(parsed.errors, [])

  const files = new Set(parsed.fileNames.map((file) => path.resolve(file)))
  assert.equal(files.has(path.resolve("next.config.ts")), true)
  assert.equal(files.has(path.resolve("src/instrumentation.ts")), true)
  assert.equal(files.has(path.resolve("scripts/trae-collector/src/extension.ts")), false)
})
