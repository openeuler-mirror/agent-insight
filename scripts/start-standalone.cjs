#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// `npm start` 入口（PR #446 审查项 4）。Next 的 standalone 输出不包含
// `.next/static` 与 `public`，直接 `node .next/standalone/server.js` 会让
// 页面 JS/CSS 404；资源复制此前只发生在 `prepack`（prepare-npm-package.js）与
// CLI 启动器（scripts/start.js）。这里在启动前对源码 checkout 补齐同一份
// 复制契约，npm 包内已带资源的目录重复同步无害（幂等）。

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function syncStandaloneAssets(packageRoot) {
  const standaloneDir = path.join(packageRoot, ".next", "standalone");
  const targets = [
    [path.join(packageRoot, ".next", "static"), path.join(standaloneDir, ".next", "static")],
    [path.join(packageRoot, "public"), path.join(standaloneDir, "public")],
  ];
  for (const [from, to] of targets) {
    if (!fs.existsSync(from)) {
      process.stderr.write(`[agent-insight] expected ${path.relative(packageRoot, from)} to exist after build; page assets may 404\n`);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
  return standaloneDir;
}

function main() {
  const packageRoot = path.resolve(__dirname, "..");
  const serverPath = path.join(packageRoot, ".next", "standalone", "server.js");
  if (!fs.existsSync(serverPath)) {
    process.stderr.write(`Missing .next/standalone/server.js. Run \`npm run build\` before \`npm start\`.\n`);
    process.exitCode = 1;
    return;
  }
  syncStandaloneAssets(packageRoot);
  const child = spawn(process.execPath, [serverPath], { stdio: "inherit", env: process.env });
  child.on("error", (error) => {
    process.stderr.write(`[agent-insight] standalone server failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
}

if (require.main === module) main();

module.exports = { syncStandaloneAssets };
