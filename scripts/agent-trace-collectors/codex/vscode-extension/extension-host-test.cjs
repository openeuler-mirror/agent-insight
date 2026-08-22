/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const Module = require("node:module");
const path = require("node:path");
const vscode = require("vscode");

const harnessPath = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "test",
  "codex-trace",
  "vscode-extension-host.cjs",
);
const originalLoad = Module._load;

try {
  Module._load = function loadWithVscode(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };
  module.exports = require(harnessPath);
} finally {
  Module._load = originalLoad;
}
