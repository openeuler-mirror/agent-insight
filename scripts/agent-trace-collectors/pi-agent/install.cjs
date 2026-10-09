#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { MANIFEST, checkManifest, installSharedModules, prepareSharedModules, validatePackage, withFileRollback, writeManifest } = require("../shared/install-modules.cjs");

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

const MIN_PI_VERSION = [0, 82, 1];

function parseSemver(value) {
  const match = /v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(String(value || ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

function isSupportedPiVersion(value) {
  const version = parseSemver(value);
  if (!version) return false;
  for (let index = 0; index < MIN_PI_VERSION.length; index += 1) {
    if (version[index] > MIN_PI_VERSION[index]) return true;
    if (version[index] < MIN_PI_VERSION[index]) return false;
  }
  return true;
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
  const reportedVersion = `${result.stdout}\n${result.stderr}`;
  if (!isSupportedPiVersion(reportedVersion)) {
    throw new Error(`Pi CLI >=0.82.1 is required; found ${parseSemver(reportedVersion)?.join(".") || "unknown"}`);
  }
}

async function copyFile(source, target, mode = 0o600) {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.copyFile(source, target);
  await fsp.chmod(target, mode).catch(() => {});
}

async function installFiles(sourceDir, packageDir, sharedDir) {
  await installSharedModules(path.resolve(sourceDir, "..", "shared"), sharedDir,
    ["trace-transport.cjs", "pi-trace-helpers.cjs", "collaboration-transport.cjs"]);
  for (const parts of PACKAGE_FILES) {
    const mode = parts[0] === "scripts" ? 0o700 : 0o600;
    await copyFile(path.join(sourceDir, ...parts), path.join(packageDir, ...parts), mode);
  }
}

async function installPackage(options) {
  const apiKey = String(process.env.AGENT_INSIGHT_API_KEY || "").trim();
  if (!apiKey) throw new Error("AGENT_INSIGHT_API_KEY is required");

  const baseUrl = String(process.env.AGENT_INSIGHT_BASE_URL || "http://127.0.0.1:3000")
    .trim()
    .replace(/\/+$/, "");
  const agentInsightHome = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME)
    : path.join(options.homeDir, ".agent-insight");
  const collectorsDir = path.join(agentInsightHome, "collectors");
  const packageDir = path.join(collectorsDir, "pi-agent");
  const sharedDir = path.join(collectorsDir, "shared");
  const endpoint = process.env.AGENT_INSIGHT_PI_ENDPOINT ||
    `${baseUrl}/api/ingest/otel/v1/traces`;
  const collaborationSessionsEndpoint = process.env.AGENT_INSIGHT_PI_COLLABORATION_SESSIONS_ENDPOINT
    || `${baseUrl}/api/ingest/collaborations/sessions`;
  const collaborationEventsEndpoint = process.env.AGENT_INSIGHT_PI_COLLABORATION_EVENTS_ENDPOINT
    || `${baseUrl}/api/ingest/collaborations/events`;
  await installFiles(options.sourceDir, packageDir, sharedDir);
  const goalPlusSourceDir = path.resolve(options.sourceDir, "..", "goal-plus");
  const { install: installGoalPlusObserver } = require(path.join(goalPlusSourceDir, "install.cjs"));
  const goalPlusObserver = await installGoalPlusObserver({
    homeDir: options.homeDir,
    sourceDir: goalPlusSourceDir,
    skipVersionCheck: true,
    createWrapper: false,
    managedBy: "pi-agent",
    deferWatcher: true,
    apiKey,
    baseUrl,
    otlpEndpoint: endpoint,
    collaborationSessionsEndpoint,
    collaborationEventsEndpoint,
  });

  const configPath = path.join(packageDir, "config.json");
  const tempPath = `${configPath}.${process.pid}.tmp`;
  const config = {
    version: 1,
    enabled: true,
    apiKey,
    endpoint,
    collaborationSessionsEndpoint,
    collaborationEventsEndpoint,
    goalPlusObserverEnabled: goalPlusObserver.observerEnabled,
    goalPlusObserverConfigPath: goalPlusObserver.configPath,
    uploadIntervalMs: 300000,
    shutdownTimeoutMs: 2200,
  };
  await fsp.mkdir(packageDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tempPath, configPath);
  await fsp.chmod(configPath, 0o600).catch(() => {});

  const registrationEnv = { ...process.env, PI_CODING_AGENT_DIR: options.piAgentDir };
  spawnSync(piCommand(), ["remove", packageDir], {
    env: registrationEnv,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  run(piCommand(), ["install", packageDir], { env: registrationEnv });
  const settings = JSON.parse(await fsp.readFile(path.join(options.piAgentDir, "settings.json"), "utf8"));
  if (!settings.packages?.some(entry => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && path.resolve(options.piAgentDir, source) === packageDir;
  })) throw new Error("Pi registration verification failed: installed collector package is not registered");
  const manifest = await writeManifest(packageDir, PACKAGE_FILES.map(parts => parts.join("/")));
  if (!(await checkManifest(packageDir)).ok) throw new Error("Pi installed files failed verification");
  run(process.execPath, [path.join(packageDir, "scripts", "self-check.cjs")], {
    env: {
      ...process.env,
      AGENT_INSIGHT_PI_CONFIG: configPath,
      AGENT_INSIGHT_USER_HOME: options.homeDir,
    },
  });
  const goalConfig = JSON.parse(await fsp.readFile(goalPlusObserver.configPath, "utf8"));
  if (goalConfig.apiKey !== config.apiKey || goalConfig.otlpEndpoint !== config.endpoint
    || goalConfig.collaborationSessionsEndpoint !== config.collaborationSessionsEndpoint
    || goalConfig.collaborationEventsEndpoint !== config.collaborationEventsEndpoint
    || config.goalPlusObserverEnabled !== true) throw new Error("Pi / Goal Plus configuration verification failed");
  return { packageDir, agentInsightHome, goalPlusObserver, buildId: manifest.buildId };
}

async function install(options) {
  assertSupportedRuntime(options.skipVersionCheck);
  const home = process.env.AGENT_INSIGHT_HOME
    ? path.resolve(process.env.AGENT_INSIGHT_HOME) : path.join(options.homeDir, ".agent-insight");
  const collectors = path.join(home, "collectors");
  const sharedDir = path.join(collectors, "shared");
  const packageDir = path.join(collectors, "pi-agent");
  const goalDir = path.join(collectors, "goal-plus");
  const goalSource = path.resolve(options.sourceDir, "..", "goal-plus");
  const goalFiles = require(path.join(goalSource, "install.cjs")).PACKAGE_FILES;
  const piFiles = PACKAGE_FILES.map(parts => parts.join("/"));
  const shared = await prepareSharedModules(path.resolve(options.sourceDir, "..", "shared"), sharedDir,
    ["trace-transport.cjs", "pi-trace-helpers.cjs", "collaboration-transport.cjs"]);
  await validatePackage(options.sourceDir, packageDir, piFiles);
  await validatePackage(goalSource, goalDir, goalFiles);
  // Load the complete incoming dependency graph before changing the installed files.
  run(process.execPath, ["-e", "require(process.argv[1]); require(process.argv[2])",
    path.join(options.sourceDir, "lib", "pi-trace-core.cjs"), path.join(goalSource, "goal-plus-collector.cjs")]);
  const piAgentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(options.homeDir, ".pi", "agent"));
  const files = [
    ...piFiles.map(name => path.join(packageDir, name)), path.join(packageDir, "config.json"), path.join(packageDir, MANIFEST),
    ...goalFiles.map(name => path.join(goalDir, name)), path.join(goalDir, "config.json"), path.join(goalDir, MANIFEST),
    ...shared.plans.map(item => item.target), path.join(sharedDir, MANIFEST), path.join(piAgentDir, "settings.json"),
  ];
  const lifecycle = require(path.join(goalSource, "goal-plus-collector.cjs"));
  const lifecycleOptions = { homeDir: options.homeDir, configPath: path.join(goalDir, "config.json") };
  const previous = await lifecycle.watcherStatus(lifecycleOptions);
  try {
    return await withFileRollback(files, async () => {
      await lifecycle.stopWatcher(lifecycleOptions);
      try {
        const result = await installPackage({ ...options, piAgentDir });
        const installed = require(path.join(goalDir, "goal-plus-collector.cjs"));
        result.goalPlusObserver.watcher = await installed.ensureWatcher(await installed.loadConfig(lifecycleOptions));
        result.goalPlusObserver.observerStatus = result.goalPlusObserver.watcher.ensured ? "active" : "dormant";
        return result;
      } catch (error) {
        await lifecycle.stopWatcher(lifecycleOptions);
        throw error;
      }
    });
  } catch (error) {
    if (previous.running) {
      try {
        const restored = require(path.join(goalDir, "goal-plus-collector.cjs"));
        await restored.ensureWatcher(await restored.loadConfig(lifecycleOptions));
      } catch (restoreError) { throw new Error(`${error.message}; watcher restore failed: ${restoreError.message}`); }
    }
    throw error;
  }
}

async function main() {
  const result = await install(parseArgs(process.argv.slice(2)));
  process.stdout.write([
    `Pi Agent collector installed at ${result.packageDir}`,
    `Goal Plus observer installed (${result.goalPlusObserver.observerStatus}). Build: ${result.buildId}`,
    "Restart Pi to load this collector build; installation does not reload existing sessions.",
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
  isSupportedPiVersion,
  parseArgs,
};
