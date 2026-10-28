#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
