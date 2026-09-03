#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
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

const COLLECTOR_VERSION = "1.0.0";
const MAX_BATCH_SNAPSHOTS = 100;
const MAX_BATCH_BYTES = 3.5 * 1024 * 1024;

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
    apiKey,
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
  const parsed = await parseGoalPlusRoot(source);
  const scanCompletedAt = new Date().toISOString();
  const batches = buildSemanticBatches(source, parsed, scanStartedAt, scanCompletedAt);
  for (const batch of batches) await enqueueSemanticBatch(batch, { apiKey: config.apiKey, homeDir: config.homeDir });
  const semanticUpload = options.upload === false
    ? { uploadedBatches: 0, uploadedSnapshots: 0 }
    : await uploadSemanticBatches({ apiKey: config.apiKey, homeDir: config.homeDir, endpoint: config.semanticEndpoint });
  const native = await importPiSessions(source.root, parsed.piSessions, {
    apiKey: config.apiKey,
    homeDir: config.homeDir,
    endpoint: config.otlpEndpoint,
    upload: options.upload,
  });
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
  const registry = await loadRegistry(defaultRegistryPath(config.homeDir));
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
    ok: Boolean(config.apiKey) && spoolWritable && sources.every(source => source.ok),
    configured: Boolean(config.apiKey),
    endpoints: {
      semantic: /^https?:\/\//.test(config.semanticEndpoint),
      otlp: /^https?:\/\//.test(config.otlpEndpoint),
    },
    spoolWritable,
    spoolBacklog,
    sources,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = await loadConfig(options);
  const registryOptions = { homeDir: config.homeDir, label: options.label };
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
    process.stdout.write(`${JSON.stringify((await loadRegistry(defaultRegistryPath(config.homeDir))).sources, null, 2)}\n`);
    return;
  }
  if (options.command === "self-check") {
    const result = await selfCheck(config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (options.command === "scan" || options.command === "watch") {
    const run = async () => {
      const sources = await resolveSources(options.values[0], registryOptions);
      const results = [];
      for (const source of sources) results.push(await scanSource(source, config, options));
      process.stdout.write(`${JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2)}\n`);
    };
    await run();
    if (options.command === "watch") {
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
    "Usage: goal-plus-collector <attach|detach|list|scan|watch|self-check> [path|sourceId]",
    "  attach <.gp> [--label name]",
    "  scan [sourceId|.gp] [--no-upload]",
    "  watch [sourceId|.gp] [--interval-ms 5000]",
  ].join("\n") + "\n");
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Goal Plus collector failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { COLLECTOR_VERSION, buildSemanticBatches, loadConfig, main, parseArgs, scanSource, selfCheck };
