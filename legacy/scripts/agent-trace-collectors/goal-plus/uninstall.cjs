#!/usr/bin/env node
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

/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WRAPPER_MARKER } = require("./install.cjs");
const { loadConfig, stopWatcher } = require("./goal-plus-collector.cjs");

async function uninstall(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME)
    : path.join(homeDir, ".agent-insight");
  const packageDir = path.join(agentInsightHome, "collectors", "goal-plus");
  const config = await loadConfig({ homeDir, configPath: path.join(packageDir, "config.json") });
  await stopWatcher(config);
  const wrapper = path.join(homeDir, ".local", "bin", "goal-plus-collector");
  if (fs.existsSync(wrapper) && (await fsp.readFile(wrapper, "utf8")).includes(WRAPPER_MARKER)) await fsp.unlink(wrapper);
  await fsp.rm(packageDir, { recursive: true, force: true });
  if (options.purgeSpool) await fsp.rm(path.join(agentInsightHome, "otel_data", "goal-plus"), { recursive: true, force: true });
  return { packageDir, spoolPreserved: !options.purgeSpool };
}

async function main() {
  const args = process.argv.slice(2);
  const homeIndex = args.indexOf("--home");
  const result = await uninstall({
    homeDir: homeIndex >= 0 ? path.resolve(args[homeIndex + 1]) : os.homedir(),
    purgeSpool: args.includes("--purge-spool"),
  });
  process.stdout.write(`Goal Plus collector removed from ${result.packageDir}; spool ${result.spoolPreserved ? "preserved" : "removed"}.\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`Goal Plus collector uninstall failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { uninstall };
