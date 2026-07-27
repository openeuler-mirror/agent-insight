#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { apiKeyHash } = require("../../shared/trace-transport.cjs");
const { loadCollectorConfig } = require("../lib/pi-trace-core.cjs");

const args = new Set(process.argv.slice(2));
const purgeCurrent = args.has("--purge");
const purgeAll = args.has("--purge-all");
const confirmed = args.has("--yes");
const homeDir = os.homedir();
const expectedPackageDir = path.resolve(homeDir, ".agent-insight", "collectors", "pi-agent");
const packageDir = path.resolve(__dirname, "..");
const piSpoolRoot = path.resolve(homeDir, ".agent-insight", "otel_data", "pi-agent");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function assertExactPath(actual, expected, label) {
  if (path.resolve(actual) !== path.resolve(expected)) {
    fail(`Refusing to remove unexpected ${label} path: ${actual}`);
  }
}

if (purgeCurrent && purgeAll) fail("Use only one of --purge or --purge-all.");
if (purgeAll && !confirmed) {
  fail("Refusing --purge-all without the second confirmation flag --yes.");
}
assertExactPath(packageDir, expectedPackageDir, "collector package");

const config = loadCollectorConfig();
const removeResult = spawnSync("pi", ["remove", packageDir], {
  encoding: "utf8",
  stdio: "inherit",
});
if (removeResult.error && removeResult.error.code !== "ENOENT") {
  fail(`Cannot invoke pi remove: ${removeResult.error.message}`);
}
if (!removeResult.error && removeResult.status !== 0) {
  fail(`pi remove exited with status ${removeResult.status}`);
}

if (purgeCurrent) {
  if (!config.apiKey) fail("Cannot resolve the current API key for --purge.");
  const currentState = path.resolve(piSpoolRoot, apiKeyHash(config.apiKey));
  assertExactPath(currentState, path.join(piSpoolRoot, apiKeyHash(config.apiKey)), "current-key spool");
  fs.rmSync(currentState, { recursive: true, force: true });
}
if (purgeAll) {
  assertExactPath(piSpoolRoot, path.join(homeDir, ".agent-insight", "otel_data", "pi-agent"), "Pi spool root");
  fs.rmSync(piSpoolRoot, { recursive: true, force: true });
}

fs.rmSync(packageDir, { recursive: true, force: true });
process.stdout.write("Pi Agent collector removed. Shared transport and non-Pi collector data were not modified.\n");
