#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WRAPPER_MARKER } = require("./install.cjs");

async function uninstall(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME)
    : path.join(homeDir, ".agent-insight");
  const packageDir = path.join(agentInsightHome, "collectors", "goal-plus");
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
