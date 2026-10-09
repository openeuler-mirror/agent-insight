#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const { selfCheck } = require("../lib/pi-trace-core.cjs");

selfCheck()
  .then((result) => {
    if (!result.ok) process.exitCode = 1;
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`Pi Agent collector self-check passed.\nEndpoint: ${result.endpoint}\nSpool: ${result.stateDir}\nBuild: ${result.installation?.buildId || "unmanaged"}\nGoal Plus observer: ${result.observer?.enabled ? (result.observer.ok ? "configured" : "failed") : "disabled"}\n`);
    } else {
      process.stderr.write(`Pi Agent collector self-check failed. Config: ${result.configPath}; checks: ${JSON.stringify(result.checks)}; observer: ${JSON.stringify(result.observer)}\n`);
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    process.stderr.write(`Pi Agent collector self-check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
