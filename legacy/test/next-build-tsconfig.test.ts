/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
