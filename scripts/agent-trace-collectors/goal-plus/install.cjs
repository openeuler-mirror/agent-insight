#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const PACKAGE_FILES = [
  "goal-plus-collector.cjs",
  "install.cjs",
  "lib/gp-snapshot-parser.cjs",
  "lib/pi-native-parser.cjs",
  "lib/semantic-spool.cjs",
  "lib/source-registry.cjs",
  "uninstall.cjs",
];
const WRAPPER_MARKER = "# managed-by-agent-insight-goal-plus";

function configuredHosts(raw = "") {
  const allowed = new Set(["pi", "codex"]);
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

async function install(options) {
  const apiKey = String(process.env.AGENT_INSIGHT_API_KEY || "").trim();
  if (!apiKey) throw new Error("AGENT_INSIGHT_API_KEY is required");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!options.skipVersionCheck && (major < 22 || (major === 22 && minor < 19))) {
    throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
  }
  const baseUrl = String(process.env.AGENT_INSIGHT_BASE_URL || "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME)
    : path.join(options.homeDir, ".agent-insight");
  const packageDir = path.join(agentInsightHome, "collectors", "goal-plus");
  for (const relative of PACKAGE_FILES) {
    await copyFile(path.join(options.sourceDir, relative), path.join(packageDir, relative), relative.endsWith(".cjs") ? 0o700 : 0o600);
  }
  const sharedTarget = path.join(agentInsightHome, "collectors", "shared", "trace-transport.cjs");
  const sharedSource = path.resolve(options.sourceDir, "..", "shared", "trace-transport.cjs");
  if (fs.existsSync(sharedTarget)) {
    const [incoming, current] = await Promise.all([fsp.readFile(sharedSource), fsp.readFile(sharedTarget)]);
    if (!incoming.equals(current)) throw new Error(`Refusing to overwrite a different shared transport at ${sharedTarget}`);
  } else {
    await copyFile(sharedSource, sharedTarget);
  }
  const piHelpersTarget = path.join(agentInsightHome, "collectors", "shared", "pi-trace-helpers.cjs");
  const piHelpersSource = path.resolve(options.sourceDir, "..", "shared", "pi-trace-helpers.cjs");
  if (fs.existsSync(piHelpersTarget)) {
    const [incoming, current] = await Promise.all([fsp.readFile(piHelpersSource), fsp.readFile(piHelpersTarget)]);
    if (!incoming.equals(current)) throw new Error(`Refusing to overwrite different shared Pi helpers at ${piHelpersTarget}`);
  } else {
    await copyFile(piHelpersSource, piHelpersTarget);
  }
  const configPath = path.join(packageDir, "config.json");
  let existingConfig = {};
  try {
    existingConfig = JSON.parse(await fsp.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const requestedHosts = String(process.env.AGENT_INSIGHT_GOAL_PLUS_HOSTS || "").trim();
  const config = {
    version: 1,
    apiKey,
    baseUrl,
    hosts: requestedHosts
      ? configuredHosts(requestedHosts)
      : configuredHosts(Array.isArray(existingConfig.hosts) ? existingConfig.hosts.join(",") : ""),
    semanticEndpoint: process.env.AGENT_INSIGHT_GOAL_PLUS_ENDPOINT || `${baseUrl}/api/ingest/goal-plus/v1/snapshots`,
    otlpEndpoint: process.env.AGENT_INSIGHT_OTLP_ENDPOINT || `${baseUrl}/api/ingest/otel/v1/traces`,
  };
  const temporary = `${configPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, configPath);

  let commandPath = path.join(packageDir, "goal-plus-collector.cjs");
  if (process.platform !== "win32") {
    const binDir = path.join(options.homeDir, ".local", "bin");
    const wrapper = path.join(binDir, "goal-plus-collector");
    if (fs.existsSync(wrapper) && !(await fsp.readFile(wrapper, "utf8")).includes(WRAPPER_MARKER)) {
      throw new Error(`Refusing to replace unmanaged command wrapper at ${wrapper}`);
    }
    await fsp.mkdir(binDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(wrapper, `#!/bin/sh\n${WRAPPER_MARKER}\nexec "${process.execPath}" "${commandPath}" "$@"\n`, { mode: 0o700 });
    commandPath = wrapper;
  }
  return { packageDir, configPath, commandPath };
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
