#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const {
  atomicWriteFile,
  installHooksDocument,
  installOtelBlock,
  serializeHooksDocument,
} = require("./config-core.cjs");
const { sha256 } = require("../shared/trace-transport.cjs");

const COLLECTOR_FILES = [
  "codex-trace-core.cjs",
  "config-core.cjs",
  "hook-handler.cjs",
  "relay.cjs",
  "self-check.cjs",
  "uninstall.cjs",
];

function parseArgs(argv) {
  const result = {
    homeDir: os.homedir(),
    sourceDir: __dirname,
    relayPort: 43191,
    startRelay: true,
    installEditors: true,
    skipVersionCheck: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--home") result.homeDir = path.resolve(argv[++index]);
    else if (arg === "--source-dir") result.sourceDir = path.resolve(argv[++index]);
    else if (arg === "--relay-port") result.relayPort = Number(argv[++index]);
    else if (arg === "--no-start") result.startRelay = false;
    else if (arg === "--skip-editor-install") result.installEditors = false;
    else if (arg === "--skip-version-check") result.skipVersionCheck = true;
    else throw new Error(`Unknown install argument: ${arg}`);
  }
  if (!Number.isInteger(result.relayPort) || result.relayPort < 1024 || result.relayPort > 65535) {
    throw new Error("Relay port must be an integer between 1024 and 65535");
  }
  return result;
}

function parseCodexVersion(output) {
  const match = /(?:codex(?:-cli)?\s+)?(\d+)\.(\d+)\.(\d+)/i.exec(String(output || ""));
  return match ? {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: match[0],
  } : undefined;
}

function isSupportedCodexVersion(version) {
  return Boolean(
    version &&
    version.major === 0 &&
    version.minor >= 145 &&
    version.minor <= 146,
  );
}

function assertSupportedRuntime(options = {}) {
  if (Number(process.versions.node.split(".")[0]) < 20) {
    throw new Error(`Node.js >=20 is required; found ${process.versions.node}`);
  }
  if (options.skipVersionCheck) return { skipped: true };
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    timeout: 5000,
  });
  const version = parseCodexVersion(`${result.stdout || ""}\n${result.stderr || ""}`);
  if (!version || result.status !== 0) {
    throw new Error("Codex CLI >=0.145.0 is required and must be available on PATH");
  }
  if (!isSupportedCodexVersion(version)) {
    throw new Error(`Codex CLI >=0.145.0 <0.147.0 is required; found ${version.raw}`);
  }
  return version;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`${filePath} is not valid JSON; no changes were made`);
    }
    throw error;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function copyFile(sourcePath, targetPath, mode = 0o600) {
  const source = await fsp.readFile(sourcePath);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(targetPath, source, { mode });
  await fsp.chmod(targetPath, mode).catch(() => {});
}

async function installCollectorFiles(sourceDir, collectorDir) {
  for (const fileName of COLLECTOR_FILES) {
    await copyFile(path.join(sourceDir, fileName), path.join(collectorDir, fileName));
  }
  const sourceShared = path.resolve(sourceDir, "..", "shared", "trace-transport.cjs");
  const targetShared = path.resolve(collectorDir, "..", "shared", "trace-transport.cjs");
  try {
    const current = await fsp.readFile(targetShared);
    const incoming = await fsp.readFile(sourceShared);
    if (!current.equals(incoming)) {
      throw new Error(`Refusing to overwrite a different shared transport at ${targetShared}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await copyFile(sourceShared, targetShared);
  }

  const extensionSource = path.join(sourceDir, "vscode-extension");
  const extensionTarget = path.join(collectorDir, "vscode-extension");
  for (const fileName of [
    "package.json",
    "extension.cjs",
    "ide-trace-core.cjs",
    "extension.vsixmanifest",
    "[Content_Types].xml",
  ]) {
    await copyFile(path.join(extensionSource, fileName), path.join(extensionTarget, fileName));
  }
  await copyFile(
    path.join(sourceDir, "build-vsix.cjs"),
    path.join(collectorDir, "build-vsix.cjs"),
  );
}

function startRelay(collectorDir, configPath) {
  const child = spawn(process.execPath, [path.join(collectorDir, "relay.cjs")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_INSIGHT_CODEX_CONFIG: configPath,
    },
  });
  child.unref();
}

async function installEditorExtensions(collectorDir) {
  const { buildVsix } = require("./build-vsix.cjs");
  const vsix = await buildVsix({
    sourceDir: path.join(collectorDir, "vscode-extension"),
    outputPath: path.join(
      collectorDir,
      "out",
      "agent-insight-codex-trace-0.1.0.vsix",
    ),
  });
  const editors = [];
  for (const command of ["code", "cursor", "windsurf"]) {
    const probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: 5000,
    });
    if (probe.error || probe.status !== 0) continue;
    const result = spawnSync(command, ["--install-extension", vsix.outputPath, "--force"], {
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: 30_000,
    });
    editors.push({
      command,
      status: result.status,
      output: String(result.stdout || result.stderr || "").trim().slice(0, 500),
    });
  }
  return { vsix, editors };
}

async function install(options) {
  const apiKey = String(process.env.AGENT_INSIGHT_API_KEY || "").trim();
  if (!apiKey) throw new Error("AGENT_INSIGHT_API_KEY is required");
  const baseUrl = String(process.env.AGENT_INSIGHT_BASE_URL || "http://127.0.0.1:3000")
    .trim()
    .replace(/\/+$/, "");
  assertSupportedRuntime(options);

  const agentInsightDir = path.join(options.homeDir, ".agent-insight");
  const collectorDir = path.join(agentInsightDir, "collectors", "codex");
  const codexDir = path.join(options.homeDir, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const codexConfigPath = path.join(codexDir, "config.toml");
  const configPath = path.join(collectorDir, "config.json");
  const statePath = path.join(collectorDir, "install-state.json");
  const handlerPath = path.join(collectorDir, "hook-handler.cjs");

  const hooksExisted = fs.existsSync(hooksPath);
  const codexConfigExisted = fs.existsSync(codexConfigPath);
  const hooksDocument = await readJsonIfExists(hooksPath, {});
  const codexConfigSource = await readTextIfExists(codexConfigPath);
  const priorConfig = await readJsonIfExists(configPath, undefined);
  const priorState = await readJsonIfExists(statePath, undefined);
  const installSecret = priorConfig?.installSecret || crypto.randomBytes(24).toString("hex");
  const hooksMutation = installHooksDocument(hooksDocument, {
    handlerPath,
    nodePath: process.execPath,
  });
  const otelMutation = installOtelBlock(codexConfigSource, {
    relayPort: options.relayPort,
    installSecret,
  });

  await installCollectorFiles(options.sourceDir, collectorDir);
  await fsp.mkdir(codexDir, { recursive: true, mode: 0o700 });
  await atomicWriteFile(hooksPath, serializeHooksDocument(hooksMutation.document));
  if (otelMutation.changed) {
    await atomicWriteFile(codexConfigPath, otelMutation.source);
  }

  const collectorConfig = {
    version: 1,
    enabled: true,
    apiKey,
    endpoint: `${baseUrl}/api/ingest/otel/v1/traces`,
    installSecret,
    relayPort: options.relayPort,
    uploadIntervalMs: 5 * 60 * 1000,
    homeDir: options.homeDir,
  };
  await atomicWriteFile(configPath, `${JSON.stringify(collectorConfig, null, 2)}\n`);
  const extensionInstall = options.installEditors
    ? await installEditorExtensions(collectorDir)
    : undefined;
  const handlerSource = await fsp.readFile(handlerPath);
  const state = {
    version: 1,
    installedAt: new Date().toISOString(),
    hooksPath,
    hooksFileExisted: priorState?.hooksFileExisted ?? hooksExisted,
    handlerPath,
    handlerSha256: sha256(handlerSource),
    codexConfigPath,
    codexConfigExisted: priorState?.codexConfigExisted ?? codexConfigExisted,
    previousOtelBlock: priorState
      ? priorState.previousOtelBlock
      : otelMutation.previousBlock,
    otelConflict: otelMutation.conflict ? otelMutation.reason : undefined,
    relayPort: options.relayPort,
    vsixPath: extensionInstall?.vsix.outputPath,
    editors: extensionInstall?.editors,
  };
  await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  if (options.startRelay) startRelay(collectorDir, configPath);
  return {
    collectorDir,
    hooksAdded: hooksMutation.added,
    otelConfigured: otelMutation.changed || !otelMutation.conflict,
    otelConflict: otelMutation.conflict ? otelMutation.reason : undefined,
    trustRequired: true,
    extensionInstall,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await install(options);
  process.stdout.write([
    `Agent Insight Codex collector installed at ${result.collectorDir}`,
    `Hooks added: ${result.hooksAdded}`,
    result.otelConflict
      ? `OTel configuration conflict: ${result.otelConflict}`
      : "Codex OTel HTTP/JSON export configured for the loopback relay.",
    "Required: start Codex, run /hooks, review the Agent Insight handlers, and trust them.",
    `Run ${commandForDisplay(process.execPath)} ${commandForDisplay(path.join(result.collectorDir, "self-check.cjs"))} after trust.`,
  ].join("\n") + "\n");
  if (result.otelConflict) process.exitCode = 2;
}

function commandForDisplay(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Agent Insight Codex install failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTOR_FILES,
  assertSupportedRuntime,
  install,
  installCollectorFiles,
  installEditorExtensions,
  isSupportedCodexVersion,
  parseArgs,
  parseCodexVersion,
};
