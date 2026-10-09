/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { atomicWriteJson, sha256 } = require("../../shared/trace-transport.cjs");

function defaultRegistryPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".agent-insight", "collectors", "goal-plus", "sources.json");
}

async function loadRegistry(registryPath = defaultRegistryPath()) {
  try {
    const value = JSON.parse(await fsp.readFile(registryPath, "utf8"));
    return value?.version === 1 && Array.isArray(value.sources) ? value : { version: 1, sources: [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, sources: [] };
    throw error;
  }
}

async function validateGoalPlusRoot(inputPath) {
  const requested = path.resolve(String(inputPath || ""));
  const directStat = await fsp.lstat(requested);
  if (!directStat.isDirectory() || directStat.isSymbolicLink()) {
    throw new Error("Goal Plus source must be a real .gp directory, not a file or symbolic link");
  }
  const root = await fsp.realpath(requested);
  if (path.basename(root) !== ".gp") throw new Error("Goal Plus source directory must be named .gp");
  const expected = ["goal-plus", "runs", "specs"];
  if (!expected.some(name => fs.existsSync(path.join(root, name)))) {
    throw new Error("Directory does not contain a recognizable Goal Plus state layout");
  }
  return root;
}

async function attachSource(inputPath, options = {}) {
  const registryPath = options.registryPath || defaultRegistryPath(options.homeDir);
  const root = await validateGoalPlusRoot(inputPath);
  const registry = await loadRegistry(registryPath);
  const existing = registry.sources.find(source => source.root === root);
  if (existing) {
    if (existing.managedBy === "pi-agent-auto-detect" && options.managedBy === existing.managedBy) {
      existing.goalId = options.goalId || existing.goalId;
      existing.nativeSessionId = options.nativeSessionId || existing.nativeSessionId;
      existing.lastDetectedAt = options.detectedAt || new Date().toISOString();
      await atomicWriteJson(registryPath, registry);
    }
    return existing;
  }
  const source = {
    sourceId: `gpsrc_${crypto.randomUUID().replaceAll("-", "")}`,
    root,
    label: options.label || path.basename(path.dirname(root)),
    workspaceFingerprint: `sha256:${sha256(path.dirname(root))}`,
    attachedAt: new Date().toISOString(),
    ...(options.managedBy ? {
      managedBy: options.managedBy,
      goalId: options.goalId,
      nativeSessionId: options.nativeSessionId,
      lastDetectedAt: options.detectedAt || new Date().toISOString(),
    } : {}),
  };
  registry.sources.push(source);
  await atomicWriteJson(registryPath, registry);
  return source;
}

async function detachSource(sourceId, options = {}) {
  const registryPath = options.registryPath || defaultRegistryPath(options.homeDir);
  const registry = await loadRegistry(registryPath);
  const before = registry.sources.length;
  registry.sources = registry.sources.filter(source => source.sourceId !== sourceId);
  if (registry.sources.length === before) return false;
  await atomicWriteJson(registryPath, registry);
  return true;
}

module.exports = {
  attachSource,
  defaultRegistryPath,
  detachSource,
  loadRegistry,
  validateGoalPlusRoot,
};
