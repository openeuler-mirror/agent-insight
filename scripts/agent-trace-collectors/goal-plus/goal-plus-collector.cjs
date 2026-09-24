#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  apiKeyHash,
  atomicWriteJson,
  collectorStateDir,
  inspectProcessLock,
  listSpoolFiles,
  readCheckpoint,
  sha256,
} = require("../shared/trace-transport.cjs");
const {
  DurableCollaborationOutbox,
} = require("../shared/collaboration-transport.cjs");
const { parseGoalPlusRoot } = require("./lib/gp-snapshot-parser.cjs");
const { importPiSessions } = require("./lib/pi-native-parser.cjs");
const {
  attachSource,
  defaultRegistryPath,
  detachSource,
  loadRegistry,
  validateGoalPlusRoot,
} = require("./lib/source-registry.cjs");

const COLLECTOR_VERSION = "2.0.0";

function watcherPaths(config) {
  const runtimeDir = path.join(path.dirname(config.configPath), "runtime");
  return {
    runtimeDir,
    pidPath: path.join(runtimeDir, "watcher.json"),
    lockPath: path.join(runtimeDir, "watcher.lock"),
    logPath: path.join(runtimeDir, "watcher.log"),
  };
}

function configFingerprint(config) {
  return `sha256:${sha256(JSON.stringify({
    collectorVersion: COLLECTOR_VERSION,
    configPath: config.configPath ? path.resolve(config.configPath) : null,
    apiKeyHash: config.apiKey ? apiKeyHash(config.apiKey) : null,
    hosts: [...(config.hosts || [])].sort(),
    otlpEndpoint: config.otlpEndpoint,
    collaborationSessionsEndpoint: config.collaborationSessionsEndpoint,
    collaborationEventsEndpoint: config.collaborationEventsEndpoint,
  }))}`;
}

function endpointIdentity(value) {
  try {
    const parsed = new URL(String(value));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[invalid-endpoint]";
  }
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
  const expectedConfigFingerprint = configFingerprint(config);
  const configMatches = !running || record?.configFingerprint === expectedConfigFingerprint;
  const uploaderInspection = config.apiKey
    ? await inspectProcessLock(path.join(
      collectorStateDir("pi-agent", config.apiKey, config.homeDir),
      "uploader.lock",
    ))
    : { state: "unconfigured", recoverable: false };
  const uploader = {
    state: uploaderInspection.state,
    recoverable: uploaderInspection.recoverable,
    ...(uploaderInspection.reason ? { reason: uploaderInspection.reason } : {}),
    ...(Number.isFinite(uploaderInspection.ageMs) ? { ageMs: uploaderInspection.ageMs } : {}),
    ...(uploaderInspection.owner ? { owner: uploaderInspection.owner } : {}),
  };
  const uploaderBlocked = ["invalid", "orphaned", "recovery-blocked"].includes(uploader.state);
  if (record && !running) await fsp.unlink(paths.pidPath).catch(() => undefined);
  return {
    configured: Boolean(config.apiKey),
    hosts: config.hosts || [],
    sourceCount: registry.sources.length,
    running,
    ready: Boolean(config.apiKey) && registry.sources.length > 0 && running && configMatches && !uploaderBlocked,
    pid: running ? record.pid : undefined,
    stalePid: record && !running ? record.pid : undefined,
    startedAt: running ? record.startedAt : undefined,
    intervalMs: running ? record.intervalMs : undefined,
    apiKeyHash: config.apiKey ? apiKeyHash(config.apiKey) : undefined,
    configFingerprint: expectedConfigFingerprint,
    activeConfigFingerprint: running ? record.configFingerprint : undefined,
    configMatches,
    uploader,
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
  const intervalMs = options.intervalMs || 5000;
  await fsp.mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await acquireWatcherLock(paths.lockPath);
  try {
    const current = await watcherStatus(config);
    if (current.running && current.configMatches && current.intervalMs === intervalMs) {
      return { ...current, alreadyRunning: true };
    }
    if (current.running) await stopWatcher(config);
    if (!config.apiKey) throw new Error("Managed Goal Plus config apiKey is required for watcher startup");
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
        String(intervalMs),
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
    const record = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      intervalMs,
      collectorVersion: COLLECTOR_VERSION,
      apiKeyHash: apiKeyHash(config.apiKey),
      configFingerprint: configFingerprint(config),
      otlpEndpoint: endpointIdentity(config.otlpEndpoint),
      collaborationSessionsEndpoint: endpointIdentity(config.collaborationSessionsEndpoint),
      collaborationEventsEndpoint: endpointIdentity(config.collaborationEventsEndpoint),
    };
    await atomicWriteJson(paths.pidPath, record);
    return {
      ...current,
      ...record,
      running: true,
      ready: true,
      configMatches: true,
      activeConfigFingerprint: record.configFingerprint,
      alreadyRunning: false,
      restartedForConfigChange: Boolean(current.running && !current.configMatches),
      restartedForIntervalChange: Boolean(
        current.running && current.configMatches && current.intervalMs !== intervalMs,
      ),
    };
  } finally {
    await fsp.unlink(paths.lockPath).catch(() => undefined);
  }
}

async function ensureWatcher(config, options = {}) {
  const previous = await watcherStatus(config);
  if (!previous.configured) {
    const stopped = previous.running ? await stopWatcher(config) : undefined;
    return {
      ...previous,
      ...(stopped || {}),
      ensured: false,
      reason: "not_configured",
      stoppedForConfigRevocation: Boolean(stopped?.stopped),
    };
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

function parseArgs(argv) {
  const result = { command: argv[0] || "help", values: [], intervalMs: 5000 };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--label") result.label = argv[++index];
    else if (arg === "--goal-id") result.goalId = argv[++index];
    else if (arg === "--native-session-id") result.nativeSessionId = argv[++index];
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
  const diagnostics = [];
  const managedApiKey = String(file.apiKey || "").trim();
  const apiKey = managedApiKey;
  const ambientBaseUrl = String(process.env.AGENT_INSIGHT_BASE_URL || "").trim();
  const explicitBaseUrl = String(process.env.AGENT_INSIGHT_GOAL_PLUS_BASE_URL || "").trim();
  const managedBaseUrl = String(file.baseUrl || "").trim();
  const baseUrl = String(explicitBaseUrl || managedBaseUrl || ambientBaseUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const explicitOtlpEndpoint = String(process.env.AGENT_INSIGHT_GOAL_PLUS_OTLP_ENDPOINT || "").trim();
  const explicitSessionsEndpoint = String(process.env.AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_SESSIONS_ENDPOINT || "").trim();
  const explicitEventsEndpoint = String(process.env.AGENT_INSIGHT_GOAL_PLUS_COLLABORATION_EVENTS_ENDPOINT || "").trim();
  const ambientOtlpEndpoint = String(process.env.AGENT_INSIGHT_OTLP_ENDPOINT || "").trim();
  if (!explicitOtlpEndpoint && file.otlpEndpoint && ambientOtlpEndpoint && file.otlpEndpoint !== ambientOtlpEndpoint) {
    diagnostics.push({
      code: "ignored_ambient_otlp_endpoint",
      message: "Ignored conflicting AGENT_INSIGHT_OTLP_ENDPOINT; managed Goal Plus config is authoritative. Use AGENT_INSIGHT_GOAL_PLUS_OTLP_ENDPOINT for an explicit override.",
    });
  }
  return {
    homeDir,
    configPath,
    registryPath: path.join(path.dirname(configPath), "sources.json"),
    apiKey,
    apiKeySource: managedApiKey ? "config" : "missing",
    configDiagnostics: diagnostics,
    hosts: ["pi"],
    otlpEndpoint: explicitOtlpEndpoint || (explicitBaseUrl
      ? `${baseUrl}/api/ingest/otel/v1/traces`
      : file.otlpEndpoint || (managedBaseUrl
        ? `${baseUrl}/api/ingest/otel/v1/traces`
        : ambientOtlpEndpoint || `${baseUrl}/api/ingest/otel/v1/traces`)),
    collaborationSessionsEndpoint: explicitSessionsEndpoint
      || (explicitBaseUrl ? "" : file.collaborationSessionsEndpoint)
      || `${baseUrl}/api/ingest/collaborations/sessions`,
    collaborationEventsEndpoint: explicitEventsEndpoint
      || (explicitBaseUrl ? "" : file.collaborationEventsEndpoint)
      || `${baseUrl}/api/ingest/collaborations/events`,
  };
}

function activationStatusPath(config) {
  return path.join(path.dirname(config.configPath), "runtime", "activation.json");
}

async function writeActivationStatus(config, status) {
  await atomicWriteJson(activationStatusPath(config), {
    version: 1,
    observedAt: new Date().toISOString(),
    ...status,
  });
}

async function readActivationStatus(config) {
  try {
    return JSON.parse(await fsp.readFile(activationStatusPath(config), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return { status: "DORMANT" };
    throw error;
  }
}

async function validateActivationEvidence(root, goalId, nativeSessionId) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(String(goalId || "")) || [".", ".."].includes(goalId)) {
    throw new Error("Goal Plus activation requires a valid goal id");
  }
  if (!String(nativeSessionId || "").trim()) {
    throw new Error("Goal Plus activation requires the current Pi native session id");
  }
  const goalPath = path.join(root, "goal-plus", goalId, "goal.json");
  const stat = await fsp.lstat(goalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Goal Plus activation evidence must be a real goal.json file");
  }
  const realGoalPath = await fsp.realpath(goalPath);
  if (realGoalPath !== path.resolve(goalPath)) {
    throw new Error("Goal Plus activation evidence must not traverse symbolic links");
  }
  const goal = JSON.parse(await fsp.readFile(realGoalPath, "utf8"));
  if (goal?.goal_plus_id !== goalId) {
    throw new Error("Goal Plus activation evidence does not match the reported goal id");
  }
  const invocation = Array.isArray(goal.host_command_invocations)
    ? goal.host_command_invocations.find(item => (
      item?.agent_harness === "pi"
      && item?.action === "start"
      && item?.session_id === nativeSessionId
    ))
    : undefined;
  if (!invocation) {
    throw new Error("Goal Plus activation evidence does not belong to the current Pi session");
  }
  return { goal, invocation };
}

async function activateGoalPlusSource(inputPath, identity, config, options = {}) {
  const goalId = String(identity?.goalId || "").trim();
  const nativeSessionId = String(identity?.nativeSessionId || "").trim();
  try {
    await writeActivationStatus(config, { status: "DETECTING", goalId, nativeSessionId });
    const root = await validateGoalPlusRoot(inputPath);
    await validateActivationEvidence(root, goalId, nativeSessionId);
    const source = await attachSource(root, {
      homeDir: config.homeDir,
      registryPath: config.registryPath,
      managedBy: "pi-agent-auto-detect",
      goalId,
      nativeSessionId,
    });
    const scan = await (options.scanSource || scanSource)(source, config, options);
    const watcher = await (options.ensureWatcher || ensureWatcher)(config, options);
    const result = {
      status: "ACTIVE",
      sourceId: source.sourceId,
      goalId,
      nativeSessionId,
      scan,
      watcher,
    };
    await writeActivationStatus(config, {
      status: result.status,
      sourceId: result.sourceId,
      goalId,
      nativeSessionId,
    });
    return result;
  } catch (error) {
    await writeActivationStatus(config, {
      status: "DEGRADED",
      goalId,
      nativeSessionId,
      error: error.message,
    }).catch(() => undefined);
    throw error;
  }
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
  if (!config.apiKey) throw new Error("Managed Goal Plus config apiKey is required for scanning");
  const scanStartedAt = new Date().toISOString();
  const parsed = await parseGoalPlusRoot(source);
  const nativeImporter = options.nativeImporter || importPiSessions;
  const relationshipOutbox = options.relationshipOutbox || new DurableCollaborationOutbox({
    framework: "goal-plus",
    apiKey: config.apiKey,
    homeDir: config.homeDir,
    sessionsEndpoint: config.collaborationSessionsEndpoint,
    eventsEndpoint: config.collaborationEventsEndpoint,
  });
  const relationshipEnqueue = await relationshipOutbox.enqueueRelationships(parsed.relationships);
  const native = await nativeImporter(source.root, parsed.piSessions, {
    apiKey: config.apiKey,
    homeDir: config.homeDir,
    endpoint: config.otlpEndpoint,
    upload: options.upload,
  });
  const relationshipUpload = options.upload === false
    ? { acquired: true, uploaded: 0, retried: 0, rejected: 0, deferred: 0 }
    : await relationshipOutbox.flushOnce();
  return {
    sourceId: source.sourceId,
    scannedAt: scanStartedAt,
    piSessions: native.imported,
    piSessionsDiscovered: parsed.piSessions.length,
    piSessionsSkipped: native.skipped || 0,
    nativeAppendedEvents: native.appendedEvents || 0,
    nativeUnchangedEvents: native.unchangedEvents || 0,
    relationshipsDiscovered: parsed.relationships.length,
    relationshipEnqueue,
    relationshipUpload,
    nativeUploadEvents: native.uploadedEvents,
    nativeUploadStatus: native.uploadStatus,
    diagnostics: [...parsed.diagnostics, ...native.diagnostics],
  };
}

async function selfCheck(config) {
  const registry = await loadRegistry(config.registryPath || defaultRegistryPath(config.homeDir));
  const sources = [];
  for (const source of registry.sources) {
    try {
      await validateGoalPlusRoot(source.root);
      const parsed = await parseGoalPlusRoot(source);
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
  let spoolBacklog = { relationshipPending: 0, relationshipRejected: 0, nativePendingFiles: 0 };
  if (config.apiKey) {
    const stateDir = collectorStateDir("goal-plus", config.apiKey, config.homeDir);
    const probe = path.join(stateDir, ".self-check");
    await atomicWriteJson(probe, { checkedAt: new Date().toISOString() });
    await fsp.unlink(probe);
    spoolWritable = true;
    const nativeStateDir = collectorStateDir("pi-agent", config.apiKey, config.homeDir);
    const nativeFiles = await listSpoolFiles(nativeStateDir);
    const nativeCheckpoint = await readCheckpoint(path.join(nativeStateDir, "uploader-checkpoint.json"));
    let nativePendingFiles = 0;
    for (const filePath of nativeFiles) {
      const relative = path.relative(nativeStateDir, filePath).replaceAll(path.sep, "/");
      if ((await fsp.stat(filePath)).size > Number(nativeCheckpoint.files[relative]?.bytes || 0)) nativePendingFiles += 1;
    }
    const relationshipOutbox = new DurableCollaborationOutbox({
      framework: "goal-plus",
      apiKey: config.apiKey,
      homeDir: config.homeDir,
      sessionsEndpoint: config.collaborationSessionsEndpoint,
      eventsEndpoint: config.collaborationEventsEndpoint,
    });
    const relationshipStatus = await relationshipOutbox.status();
    spoolBacklog = {
      relationshipPending: relationshipStatus.pending,
      relationshipRejected: relationshipStatus.rejected,
      nativePendingFiles,
    };
  }
  const watcher = await watcherStatus(config);
  const activation = await readActivationStatus(config);
  const uploaderBlocked = ["invalid", "orphaned", "recovery-blocked"].includes(watcher.uploader?.state);
  return {
    ok: Boolean(config.apiKey) && spoolWritable && sources.length > 0
      && sources.every(source => source.ok) && !uploaderBlocked
      && spoolBacklog.relationshipRejected === 0,
    configured: Boolean(config.apiKey),
    configDiagnostics: config.configDiagnostics || [],
    endpoints: {
      otlp: /^https?:\/\//.test(config.otlpEndpoint),
      collaborationSessions: /^https?:\/\//.test(config.collaborationSessionsEndpoint),
      collaborationEvents: /^https?:\/\//.test(config.collaborationEventsEndpoint),
    },
    spoolWritable,
    spoolBacklog,
    watcher,
    activation,
    sources,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = await loadConfig(options);
  for (const diagnostic of config.configDiagnostics || []) {
    process.stderr.write(`Goal Plus collector config warning [${diagnostic.code}]: ${diagnostic.message}\n`);
  }
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
  if (options.command === "activate") {
    if (!options.values[0]) throw new Error("activate requires a .gp path");
    if (!options.goalId) throw new Error("activate requires --goal-id");
    if (!options.nativeSessionId) throw new Error("activate requires --native-session-id");
    const result = await activateGoalPlusSource(options.values[0], {
      goalId: options.goalId,
      nativeSessionId: options.nativeSessionId,
    }, config, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    "Usage: goal-plus-collector <activate|attach|detach|list|scan|watch|start|ensure|stop|status|self-check> [path|sourceId]",
    "  activate <.gp> --goal-id <id> --native-session-id <id>",
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
  activateGoalPlusSource,
  activationStatusPath,
  ensureWatcher,
  loadConfig,
  main,
  parseArgs,
  readActivationStatus,
  scanSource,
  selfCheck,
  startWatcher,
  stopWatcher,
  watcherStatus,
};
