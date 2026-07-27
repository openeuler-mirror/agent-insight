#!/usr/bin/env node
"use strict";

const { selfCheck } = require("../lib/pi-trace-core.cjs");

selfCheck()
  .then((result) => {
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(`Pi Agent collector self-check passed.\nEndpoint: ${result.endpoint}\nSpool: ${result.stateDir}\n`);
    } else {
      process.stderr.write(`Pi Agent collector is not configured. Config: ${result.configPath}\n`);
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    process.stderr.write(`Pi Agent collector self-check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
