import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const runtimeDir = path.resolve(process.argv[2] || "")
const setupPath = path.join(runtimeDir, "qoder_setup.mjs")

try {
  execFileSync("node", [
    setupPath,
    "uninstall",
    "--scope=user",
    "--product=jetbrains",
    "--owner=jetbrains",
    "--purge",
  ], { windowsHide: true, timeout: 20_000, stdio: "ignore" })
} catch {}

if (runtimeDir.endsWith(path.join(".agent-insight", "qoder-jetbrains", "runtime"))) {
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }) } catch {}
  // JetBrains may dispose application services either before or after the
  // plugin-unload listener. Remove the product root when the marker service
  // has already emptied it; otherwise that service performs the same cleanup.
  try { fs.rmdirSync(path.dirname(runtimeDir)) } catch {}
}
