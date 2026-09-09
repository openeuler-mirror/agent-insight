#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { atomicWriteJson, collectorStateDir, listSpoolFiles, readCheckpoint, safeContent } = require("../shared/trace-transport.cjs");
const { parseGoalPlusRoot } = require("./lib/gp-snapshot-parser.cjs");
const { importPiSessions } = require("./lib/pi-native-parser.cjs");
const { enqueueSemanticBatch, semanticStateDir, uploadSemanticBatches } = require("./lib/semantic-spool.cjs");
const {
  attachSource,
  defaultRegistryPath,
  detachSource,
  loadRegistry,
  validateGoalPlusRoot,
} = require("./lib/source-registry.cjs");

const COLLECTOR_VERSION = "1.2.1";
const MAX_BATCH_SNAPSHOTS = 100;
const MAX_BATCH_BYTES = 3.5 * 1024 * 1024;

function watcherPaths(config) {
  const runtimeDir = path.join(path.dirname(config.configPath), "runtime");
  return {
    runtimeDir,
    pidPath: path.join(runtimeDir, "watcher.json"),
    lockPath: path.join(runtimeDir, "watcher.lock"),
    logPath: path.join(runtimeDir, "watcher.log"),
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readWatcherPid(pidPath) {
  try {
    const value = JSON.parse(await fsp.readFile(pidPath, "utf8"));
    return Number.isInteger(value?.pid) ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function watcherStatus(config) {
  const paths = watcherPaths(config);
  const registry = await loadRegistry(config.registryPath || defaultRegistryPath(config.homeDir));
  const record = await readWatcherPid(paths.pidPath);
  const running = Boolean(record && processIsAlive(record.pid));
  if (record && !running) await fsp.unlink(paths.pidPath).catch(() => undefined);
  return {
    configured: Boolean(config.apiKey),
    hosts: config.hosts || [],
    sourceCount: registry.sources.length,
    running,
    ready: Boolean(config.apiKey) && registry.sources.length > 0 && running,
    pid: running ? record.pid : undefined,
    stalePid: record && !running ? record.pid : undefined,
    startedAt: running ? record.startedAt : undefined,
    logPath: paths.logPath,
  };
}

async function acquireWatcherLock(lockPath) {
  try {
    await fsp.writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const ownerPid = Number.parseInt(await fsp.readFile(lockPath, "utf8").catch(() => ""), 10);
  if (processIsAlive(ownerPid)) throw new Error("Goal Plus watcher start is already in progress");
  await fsp.unlink(lockPath).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  });
  try {
    await fsp.writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Goal Plus watcher start is already in progress");
    throw error;
  }
}

async function startWatcher(config, options = {}) {
  const paths = watcherPaths(config);
  await fsp.mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await acquireWatcherLock(paths.lockPath);
  try {
    const current = await watcherStatus(config);
    if (current.running) return { ...current, alreadyRunning: true };
    if (!config.apiKey) throw new Error("AGENT_INSIGHT_API_KEY or collector config apiKey is required for watcher startup");
    if (current.sourceCount === 0) throw new Error("No Goal Plus sources are attached; run attach before start");
    const logFd = fs.openSync(paths.logPath, "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, [
        __filename,
        "watch",
        "--config",
        config.configPath,
        "--home",
        config.homeDir,
        "--interval-ms",
        String(options.intervalMs || 5000),
      ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
    } finally {
      fs.closeSync(logFd);
    }
    if (!child.pid) throw new Error("Unable to start Goal Plus watcher process");
    child.unref();
    const record = { pid: child.pid, startedAt: new Date().toISOString(), intervalMs: options.intervalMs || 5000 };
    await atomicWriteJson(paths.pidPath, record);
    return { ...current, ...record, running: true, ready: true, alreadyRunning: false };
  } finally {
    await fsp.unlink(paths.lockPath).catch(() => undefined);
  }
}

async function ensureWatcher(config, options = {}) {
  const previous = await watcherStatus(config);
  if (!previous.configured) {
    return { ...previous, ensured: false, reason: "not_configured" };
  }
  if (previous.sourceCount === 0) {
    return { ...previous, ensured: false, reason: "no_sources" };
  }
  const current = await startWatcher(config, options);
  return {
    ...current,
    ensured: true,
    recoveredStalePid: previous.stalePid,
  };
}

async function stopWatcher(config) {
  const paths = watcherPaths(config);
  const record = await readWatcherPid(paths.pidPath);
  if (!record || !processIsAlive(record.pid)) {
    await fsp.unlink(paths.pidPath).catch(() => undefined);
    return { stopped: false, running: false, ready: false };
  }
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await fsp.unlink(paths.pidPath).catch(() => undefined);
  return { stopped: true, running: false, ready: false, pid: record.pid };
}

function buildSemanticBatches(source, parsed, scanStartedAt, scanCompletedAt) {
  const groups = [];
  let current = [];
  let currentBytes = 0;
  for (const snapshot of parsed.snapshots) {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    if (current.length && (current.length >= MAX_BATCH_SNAPSHOTS || currentBytes + bytes > MAX_BATCH_BYTES)) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(snapshot);
    currentBytes += bytes;
  }
  if (current.length || !groups.length) groups.push(current);
  return groups.map((snapshots, index) => ({
    format: "agent-insight.goal-plus-batch",
    version: 1,
    source: {
      sourceId: source.sourceId,
      workspaceFingerprint: source.workspaceFingerprint,
      collectorVersion: COLLECTOR_VERSION,
      label: safeContent(source.label, 160),
      ...(index === groups.length - 1 ? { scanCompletedAt } : {}),
      semanticCheckpoint: {
        scanStartedAt,
        scannedFiles: parsed.scannedFiles,
        snapshotCount: parsed.snapshots.length,
        batchOrdinal: index,
        batchCount: groups.length,
      },
    },
    snapshots,
  }));
}

function parseArgs(argv) {
  const result = { command: argv[0] || "help", values: [], intervalMs: 5000 };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--label") result.label = argv[++index];
    else if (arg === "--home") result.homeDir = path.resolve(argv[++index]);
    else if (arg === "--config") result.configPath = path.resolve(argv[++index]);
    else if (arg === "--interval-ms") result.intervalMs = Math.max(1000, Number(argv[++index]) || 5000);
    else if (arg === "--no-upload") result.upload = false;
    else result.values.push(arg);
  }
  return result;
}

async function loadConfig(options = {}) {
  const homeDir = options.homeDir || process.env.AGENT_INSIGHT_USER_HOME || os.homedir();
  const configPath = options.configPath || process.env.AGENT_INSIGHT_GOAL_PLUS_CONFIG || path.join(
    homeDir,
    ".agent-insight",
    "collectors",
    "goal-plus",
    "config.json",
  );
  let file = {};
  try {
    file = JSON.parse(await fsp.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const apiKey = process.env.AGENT_INSIGHT_API_KEY || file.apiKey;
  const baseUrl = String(process.env.AGENT_INSIGHT_BASE_URL || file.baseUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
  return {
    homeDir,
    configPath,
    registryPath: path.join(path.dirname(configPath), "sources.json"),
    apiKey,
    hosts: Array.isArray(file.hosts) ? file.hosts.filter(host => host === "pi" || host === "codex") : [],
    semanticEndpoint: process.env.AGENT_INSIGHT_GOAL_PLUS_ENDPOINT || file.semanticEndpoint || `${baseUrl}/api/ingest/goal-plus/v1/snapshots`,
    otlpEndpoint: process.env.AGENT_INSIGHT_OTLP_ENDPOINT || file.otlpEndpoint || `${baseUrl}/api/ingest/otel/v1/traces`,
  };
}

async function resolveSources(selector, options) {
  const registry = await loadRegistry(options.registryPath || defaultRegistryPath(options.homeDir));
  if (!selector) return registry.sources;
  const registered = registry.sources.find(source => source.sourceId === selector || source.root === path.resolve(selector));
  if (registered) return [registered];
  const root = await validateGoalPlusRoot(selector);
  return [await attachSource(root, options)];
}

async function scanSource(source, config, options = {}) {
  if (!config.apiKey) throw new Error("AGENT_INSIGHT_API_KEY or collector config apiKey is required for scanning");
  const scanStartedAt = new Date().toISOString();
  const parsed = await parseGoalPlusRoot(source, { homeDir: config.homeDir });
  const scanCompletedAt = new Date().toISOString();
  const batches = buildSemanticBatches(source, parsed, scanStartedAt, scanCompletedAt);
  for (const batch of batches) await enqueueSemanticBatch(batch, { apiKey: config.apiKey, homeDir: config.homeDir });
  const nativeImporter = options.nativeImporter || importPiSessions;
  const semanticUploader = options.semanticUploader || uploadSemanticBatches;
  const native = await nativeImporter(source.root, parsed.piSessions, {
    apiKey: config.apiKey,
    homeDir: config.homeDir,
    endpoint: config.otlpEndpoint,
    upload: options.upload,
  });
  const semanticUpload = options.upload === false
    ? { uploadedBatches: 0, uploadedSnapshots: 0 }
    : await semanticUploader({ apiKey: config.apiKey, homeDir: config.homeDir, endpoint: config.semanticEndpoint });
  return {
    sourceId: source.sourceId,
    snapshots: parsed.snapshots.length,
    piSessions: native.imported,
    semanticUpload,
    nativeUploadEvents: native.uploadedEvents,
    diagnostics: [...parsed.diagnostics, ...native.diagnostics],
  };
}

async function selfCheck(config) {
  const registry = await loadRegistry(config.registryPath || defaultRegistryPath(config.homeDir));
  const sources = [];
  for (const source of registry.sources) {
    try {
      await validateGoalPlusRoot(source.root);
      const parsed = await parseGoalPlusRoot(source, { homeDir: config.homeDir });
      const objectCounts = {};
      for (const snapshot of parsed.snapshots) objectCounts[snapshot.kind] = (objectCounts[snapshot.kind] || 0) + 1;
      sources.push({
        sourceId: source.sourceId,
        ok: parsed.diagnostics.length === 0,
        parserVersions: [...new Set(parsed.snapshots.map(snapshot => snapshot.version))].sort(),
        objectCounts,
        piSessionCoverage: {
          referenced: parsed.piSessions.length,
          agentSessionObjects: objectCounts.agent_session || 0,
        },
        diagnostics: parsed.diagnostics,
      });
    } catch (error) {
      sources.push({ sourceId: source.sourceId, ok: false, error: error.message });
    }
  }
  let spoolWritable = false;
  let spoolBacklog = { semanticPending: 0, semanticRejected: 0, nativePendingFiles: 0 };
  if (config.apiKey) {
    const stateDir = collectorStateDir("goal-plus", config.apiKey, config.homeDir);
    const probe = path.join(stateDir, ".self-check");
    await atomicWriteJson(probe, { checkedAt: new Date().toISOString() });
    await fsp.unlink(probe);
    spoolWritable = true;
    const semanticDir = semanticStateDir(config.apiKey, config.homeDir);
    const countJson = async directory => (await fsp.readdir(directory).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    })).filter(name => name.endsWith(".json")).length;
    const nativeStateDir = collectorStateDir("pi-agent", config.apiKey, config.homeDir);
    const nativeFiles = await listSpoolFiles(nativeStateDir);
    const nativeCheckpoint = await readCheckpoint(path.join(nativeStateDir, "uploader-checkpoint.json"));
    let nativePendingFiles = 0;
    for (const filePath of nativeFiles) {
      const relative = path.relative(nativeStateDir, filePath).replaceAll(path.sep, "/");
      if ((await fsp.stat(filePath)).size > Number(nativeCheckpoint.files[relative]?.bytes || 0)) nativePendingFiles += 1;
    }
    spoolBacklog = {
      semanticPending: await countJson(path.join(semanticDir, "pending")),
      semanticRejected: await countJson(path.join(semanticDir, "rejected")),
      nativePendingFiles,
    };
  }
  return {
    ok: Boolean(config.apiKey) && spoolWritable && sources.length > 0 && sources.every(source => source.ok),
    configured: Boolean(config.apiKey),
    endpoints: {
      semantic: /^https?:\/\//.test(config.semanticEndpoint),
      otlp: /^https?:\/\//.test(config.otlpEndpoint),
    },
    spoolWritable,
    spoolBacklog,
    watcher: await watcherStatus(config),
    sources,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = await loadConfig(options);
  const registryOptions = { homeDir: config.homeDir, registryPath: config.registryPath, label: options.label };
  if (options.command === "attach") {
    if (!options.values[0]) throw new Error("attach requires a .gp path");
    process.stdout.write(`${JSON.stringify(await attachSource(options.values[0], registryOptions), null, 2)}\n`);
    return;
  }
  if (options.command === "detach") {
    if (!options.values[0]) throw new Error("detach requires a sourceId");
    process.stdout.write(`${JSON.stringify({ detached: await detachSource(options.values[0], registryOptions) })}\n`);
    return;
  }
  if (options.command === "list") {
    process.stdout.write(`${JSON.stringify((await loadRegistry(config.registryPath || defaultRegistryPath(config.homeDir))).sources, null, 2)}\n`);
    return;
  }
  if (options.command === "self-check") {
    const result = await selfCheck(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (options.command === "start") {
    process.stdout.write(`${JSON.stringify(await startWatcher(config, options), null, 2)}\n`);
    return;
  }
  if (options.command === "ensure") {
    process.stdout.write(`${JSON.stringify(await ensureWatcher(config, options), null, 2)}\n`);
    return;
  }
  if (options.command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopWatcher(config), null, 2)}\n`);
    return;
  }
  if (options.command === "status") {
    process.stdout.write(`${JSON.stringify(await watcherStatus(config), null, 2)}\n`);
    return;
  }
  if (options.command === "scan" || options.command === "watch") {
    const run = async () => {
      const sources = await resolveSources(options.values[0], registryOptions);
      const results = [];
      for (const source of sources) results.push(await scanSource(source, config, options));
      process.stdout.write(`${JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2)}\n`);
    };
    if (options.command === "scan") await run();
    else {
      try { await run(); } catch (error) { process.stderr.write(`Goal Plus watch scan failed: ${error.message}\n`); }
      let active = false;
      const timer = setInterval(async () => {
        if (active) return;
        active = true;
        try { await run(); } catch (error) { process.stderr.write(`Goal Plus watch scan failed: ${error.message}\n`); }
        finally { active = false; }
      }, options.intervalMs);
      for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearInterval(timer); process.exit(0); });
    }
    return;
  }
  process.stdout.write([
    "Usage: goal-plus-collector <attach|detach|list|scan|watch|start|ensure|stop|status|self-check> [path|sourceId]",
    "  attach <.gp> [--label name]",
    "  scan [sourceId|.gp] [--no-upload]",
    "  watch [sourceId|.gp] [--interval-ms 5000]",
    "  start [--interval-ms 5000]",
    "  ensure [--interval-ms 5000]",
    "  stop",
    "  status",
  ].join("\n") + "\n");
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Goal Plus collector failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLLECTOR_VERSION,
  buildSemanticBatches,
  ensureWatcher,
  loadConfig,
  main,
  parseArgs,
  scanSource,
  selfCheck,
  startWatcher,
  stopWatcher,
  watcherStatus,
};
