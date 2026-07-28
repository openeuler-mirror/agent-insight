#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_FILES = [
  ["package.json"],
  ["extensions", "pi-agent-insight.ts"],
  ["lib", "pi-trace-core.cjs"],
  ["scripts", "self-check.cjs"],
  ["scripts", "uninstall.cjs"],
];

function parseArgs(argv) {
  const result = {
    homeDir: os.homedir(),
    sourceDir: __dirname,
    skipVersionCheck: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--home") result.homeDir = path.resolve(argv[++index]);
    else if (arg === "--source-dir") result.sourceDir = path.resolve(argv[++index]);
    else if (arg === "--skip-version-check") result.skipVersionCheck = true;
    else throw new Error(`Unknown install argument: ${arg}`);
  }
  return result;
}

function piCommand() {
  return "pi";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function assertSupportedRuntime(skipVersionCheck = false) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
  }
  if (skipVersionCheck) return;
  const result = run(piCommand(), ["--version"]);
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${result.stdout}\n${result.stderr}`);
  if (!match || Number(match[1]) !== 0 || Number(match[2]) !== 82) {
    throw new Error(`Pi CLI >=0.82.1 <0.83.0 is required; found ${match?.[0] || "unknown"}`);
  }
}

async function copyFile(source, target, mode = 0o600) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.copyFile(source, target);
  await fsp.chmod(target, mode).catch(() => {});
}

async function installFiles(sourceDir, packageDir, sharedDir) {
  for (const parts of PACKAGE_FILES) {
    const mode = parts[0] === "scripts" ? 0o700 : 0o600;
    await copyFile(path.join(sourceDir, ...parts), path.join(packageDir, ...parts), mode);
  }

  const incomingPath = path.resolve(sourceDir, "..", "shared", "trace-transport.cjs");
  const targetPath = path.join(sharedDir, "trace-transport.cjs");
  if (fs.existsSync(targetPath)) {
    const [incoming, current] = await Promise.all([
      fsp.readFile(incomingPath),
      fsp.readFile(targetPath),
    ]);
    if (!incoming.equals(current)) {
      throw new Error(`Refusing to overwrite a different shared transport at ${targetPath}`);
    }
  } else {
    await copyFile(incomingPath, targetPath);
  }
}

async function install(options) {
  const apiKey = String(process.env.AGENT_INSIGHT_API_KEY || "").trim();
  if (!apiKey) throw new Error("AGENT_INSIGHT_API_KEY is required");
  assertSupportedRuntime(options.skipVersionCheck);

  const baseUrl = String(process.env.AGENT_INSIGHT_BASE_URL || "http://127.0.0.1:3000")
    .trim()
    .replace(/\/+$/, "");
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME)
    : path.join(options.homeDir, ".agent-insight");
  const collectorsDir = path.join(agentInsightHome, "collectors");
  const packageDir = path.join(collectorsDir, "pi-agent");
  const sharedDir = path.join(collectorsDir, "shared");
  await installFiles(options.sourceDir, packageDir, sharedDir);

  const configPath = path.join(packageDir, "config.json");
  const tempPath = `${configPath}.${process.pid}.tmp`;
  const config = {
    version: 1,
    enabled: true,
    apiKey,
    endpoint: process.env.AGENT_INSIGHT_PI_ENDPOINT ||
      `${baseUrl}/api/ingest/otel/v1/traces`,
    uploadIntervalMs: 300000,
    shutdownTimeoutMs: 2200,
  };
  await fsp.mkdir(packageDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tempPath, configPath);
  await fsp.chmod(configPath, 0o600).catch(() => {});

  spawnSync(piCommand(), ["remove", packageDir], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  run(piCommand(), ["install", packageDir]);
  run(process.execPath, [path.join(packageDir, "scripts", "self-check.cjs")], {
    env: {
      ...process.env,
      AGENT_INSIGHT_PI_CONFIG: configPath,
      AGENT_INSIGHT_USER_HOME: options.homeDir,
    },
  });
  return { packageDir, agentInsightHome };
}

async function main() {
  const result = await install(parseArgs(process.argv.slice(2)));
  process.stdout.write([
    `Pi Agent collector installed at ${result.packageDir}`,
    `Spool data is isolated under ${path.join(result.agentInsightHome, "otel_data", "pi-agent", "<api-key-hash>")}`,
  ].join("\n") + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Pi Agent collector installation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PACKAGE_FILES,
  assertSupportedRuntime,
  install,
  installFiles,
  parseArgs,
};
