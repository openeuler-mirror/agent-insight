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

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const runtimeDir = path.resolve(process.argv[2] || "")
const setupPath = path.join(runtimeDir, "qoder_setup.mjs")

try {
  execFileSync("node", [
    setupPath,
    "uninstall",
    "--scope=user",
    "--product=jetbrains",
    "--owner=jetbrains",
    "--purge",
  ], { windowsHide: true, timeout: 20_000, stdio: "ignore" })
} catch {}

if (runtimeDir.endsWith(path.join(".agent-insight", "qoder-jetbrains", "runtime"))) {
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }) } catch {}
  // JetBrains may dispose application services either before or after the
  // plugin-unload listener. Remove the product root when the marker service
  // has already emptied it; otherwise that service performs the same cleanup.
  try { fs.rmdirSync(path.dirname(runtimeDir)) } catch {}
}
