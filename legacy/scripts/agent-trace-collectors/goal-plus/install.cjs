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
const { MANIFEST, checkManifest, installSharedModules, prepareSharedModules, validatePackage, withFileRollback, writeManifest } = require("../shared/install-modules.cjs");

const PACKAGE_FILES = [
  "goal-plus-collector.cjs",
  "install.cjs",
  "lib/gp-snapshot-parser.cjs",
  "lib/pi-native-parser.cjs",
  "lib/source-registry.cjs",
  "uninstall.cjs",
];
const WRAPPER_MARKER = "# managed-by-agent-insight-goal-plus";

function configuredHosts(raw = "") {
  const allowed = new Set(["pi"]);
  return [...new Set(String(raw).split(",").map(value => value.trim().toLowerCase()).filter(value => allowed.has(value)))];
}

function parseArgs(argv) {
  const result = { homeDir: os.homedir(), sourceDir: __dirname, skipVersionCheck: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--home") result.homeDir = path.resolve(argv[++index]);
    else if (argv[index] === "--source-dir") result.sourceDir = path.resolve(argv[++index]);
    else if (argv[index] === "--skip-version-check") result.skipVersionCheck = true;
    else throw new Error(`Unknown install argument: ${argv[index]}`);
  }
  return result;
}

async function copyFile(source, target, mode = 0o600) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.copyFile(source, target);
  await fsp.chmod(target, mode).catch(() => undefined);
}

async function installPackage(options) {
  const apiKey = String(options.apiKey || process.env.AGENT_INSIGHT_API_KEY || "").trim();
  if (!apiKey) throw new Error("AGENT_INSIGHT_API_KEY is required");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!options.skipVersionCheck && (major < 22 || (major === 22 && minor < 19))) {
    throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
  }
  const baseUrl = String(options.baseUrl || process.env.AGENT_INSIGHT_BASE_URL || "http://127.0.0.1:3000")
    .trim()
    .replace(/\/+$/, "");
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME)
    : path.join(options.homeDir, ".agent-insight");
  const packageDir = path.join(agentInsightHome, "collectors", "goal-plus");
  const configPath = path.join(packageDir, "config.json");
  await installSharedModules(path.resolve(options.sourceDir, "..", "shared"),
    path.join(agentInsightHome, "collectors", "shared"),
    ["trace-transport.cjs", "pi-trace-helpers.cjs", "collaboration-transport.cjs"]);
  for (const relative of PACKAGE_FILES) {
    await copyFile(path.join(options.sourceDir, relative), path.join(packageDir, relative), relative.endsWith(".cjs") ? 0o700 : 0o600);
  }
  const config = {
    version: 1,
    apiKey,
    baseUrl,
    hosts: configuredHosts("pi"),
    ...(options.managedBy ? { managedBy: options.managedBy } : {}),
    otlpEndpoint: options.otlpEndpoint
      || process.env.AGENT_INSIGHT_OTLP_ENDPOINT
      || `${baseUrl}/api/ingest/otel/v1/traces`,
    collaborationSessionsEndpoint: options.collaborationSessionsEndpoint
      || process.env.AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_SESSIONS_ENDPOINT
      || `${baseUrl}/api/ingest/collaborations/sessions`,
    collaborationEventsEndpoint: options.collaborationEventsEndpoint
      || process.env.AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_EVENTS_ENDPOINT
      || `${baseUrl}/api/ingest/collaborations/events`,
  };
  require(path.join(packageDir, "goal-plus-collector.cjs"));
  const stoppedWatcher = options.stoppedWatcher || { stopped: false };
  const temporary = `${configPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, configPath);
  await fsp.chmod(configPath, 0o600).catch(() => undefined);
  const watcher = { ensured: false };

  let commandPath = path.join(packageDir, "goal-plus-collector.cjs");
  if (process.platform !== "win32" && options.createWrapper !== false) {
    const binDir = path.join(options.homeDir, ".local", "bin");
    const wrapper = path.join(binDir, "goal-plus-collector");
    if (fs.existsSync(wrapper) && !(await fsp.readFile(wrapper, "utf8")).includes(WRAPPER_MARKER)) {
      throw new Error(`Refusing to replace unmanaged command wrapper at ${wrapper}`);
    }
    await fsp.mkdir(binDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(wrapper, `#!/bin/sh\n${WRAPPER_MARKER}\nexec "${process.execPath}" "${commandPath}" "$@"\n`, { mode: 0o700 });
    commandPath = wrapper;
  }
  const manifest = await writeManifest(packageDir, PACKAGE_FILES);
  if (!(await checkManifest(packageDir)).ok) throw new Error("Goal Plus installed files failed verification");
  return {
    buildId: manifest.buildId,
    packageDir,
    configPath,
    commandPath,
    observerEnabled: true,
    observerStatus: watcher.ensured ? "active" : "dormant",
    stoppedWatcher,
    watcher,
  };
}

async function install(options) {
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME) : path.join(options.homeDir, ".agent-insight");
  const packageDir = path.join(agentInsightHome, "collectors", "goal-plus");
  const sharedDir = path.join(agentInsightHome, "collectors", "shared");
  const configPath = path.join(packageDir, "config.json");
  const shared = await prepareSharedModules(path.resolve(options.sourceDir, "..", "shared"), sharedDir,
    ["trace-transport.cjs", "pi-trace-helpers.cjs", "collaboration-transport.cjs"]);
  await validatePackage(options.sourceDir, packageDir, PACKAGE_FILES);
  const files = [...PACKAGE_FILES, "config.json", MANIFEST].map(name => path.join(packageDir, name));
  if (process.platform !== "win32" && options.createWrapper !== false) {
    const wrapper = path.join(options.homeDir, ".local", "bin", "goal-plus-collector");
    if (fs.existsSync(wrapper) && !(await fsp.readFile(wrapper, "utf8")).includes(WRAPPER_MARKER)) {
      throw new Error(`Refusing to replace unmanaged command wrapper at ${wrapper}`);
    }
    files.push(wrapper);
  }
  files.push(...shared.plans.map(item => item.target), path.join(sharedDir, MANIFEST));
  const lifecycle = require("./goal-plus-collector.cjs");
  let stoppedWatcher;
  try {
    return await withFileRollback(files, async () => {
      stoppedWatcher = await lifecycle.stopWatcher({ homeDir: options.homeDir, configPath });
      try {
        const result = await installPackage({ ...options, stoppedWatcher });
        if (!options.deferWatcher) {
          const installed = require(path.join(packageDir, "goal-plus-collector.cjs"));
          result.watcher = await installed.ensureWatcher(await installed.loadConfig({ homeDir: options.homeDir, configPath }));
          result.observerStatus = result.watcher.ensured ? "active" : "dormant";
        }
        return result;
      } catch (error) {
        await lifecycle.stopWatcher({ homeDir: options.homeDir, configPath });
        throw error;
      }
    });
  } catch (error) {
    if (stoppedWatcher?.stopped) {
      try {
        const previous = require(path.join(packageDir, "goal-plus-collector.cjs"));
        await previous.ensureWatcher(await previous.loadConfig({ homeDir: options.homeDir, configPath }));
      } catch (restoreError) { throw new Error(`${error.message}; watcher restore failed: ${restoreError.message}`); }
    }
    throw error;
  }
}

async function main() {
  const result = await install(parseArgs(process.argv.slice(2)));
  process.stdout.write(`Goal Plus collector installed at ${result.packageDir}\nCommand: ${result.commandPath}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`Goal Plus collector installation failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { PACKAGE_FILES, WRAPPER_MARKER, configuredHosts, install, parseArgs };
