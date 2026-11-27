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
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { syncGeneratedPrismaClient } = require("../scripts/sync-prisma-client.js")

test("generated Prisma client is synced for hoisted and standalone runtimes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-insight-prisma-sync-"))
  const packageRoot = path.join(root, "node_modules", "agent-insight")
  const generatedClient = path.join(packageRoot, "node_modules", ".prisma", "client")
  const hoistedClientPackage = path.join(root, "node_modules", "@prisma", "client")
  const standaloneDir = path.join(packageRoot, ".next", "standalone")

  fs.mkdirSync(generatedClient, { recursive: true })
  fs.writeFileSync(path.join(generatedClient, "index.js"), "module.exports = 'generated'\n")
  fs.mkdirSync(hoistedClientPackage, { recursive: true })
  fs.mkdirSync(standaloneDir, { recursive: true })
  fs.writeFileSync(
    path.join(hoistedClientPackage, "package.json"),
    JSON.stringify({ name: "@prisma/client", version: "5.22.0" }),
  )

  syncGeneratedPrismaClient(packageRoot, standaloneDir)

  assert.equal(
    fs.readFileSync(path.join(root, "node_modules", ".prisma", "client", "index.js"), "utf8"),
    "module.exports = 'generated'\n",
  )
  assert.equal(
    fs.readFileSync(
      path.join(standaloneDir, "node_modules", ".prisma", "client", "index.js"),
      "utf8",
    ),
    "module.exports = 'generated'\n",
  )
})
