/**
 * Temporary OpenCode plugin: probe bun:ffi → libpython inside the real OC process.
 * Writes JSON to ~/.agent-insight/ras/opencode_bun_ffi_probe.json at import time.
 */
import { dlopen, FFIType } from "bun:ffi"
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const RAS_HOME = join(homedir(), ".agent-insight", "ras")
const OUT =
  process.env.RAS_FFI_PROBE_OUT || join(RAS_HOME, "opencode_bun_ffi_probe.json")
const LOG =
  process.env.RAS_FFI_PROBE_LOG || join(RAS_HOME, "opencode_bun_ffi_probe.log")

function log(line) {
  try {
    mkdirSync(RAS_HOME, { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* ignore */
  }
}

function probe() {
  const result = {
    when: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform,
    bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
    steps: {},
    env: {
      LD_PRELOAD: process.env.LD_PRELOAD || null,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || null,
      PYTHONHOME: process.env.PYTHONHOME || null,
      PYTHONPATH: process.env.PYTHONPATH || null,
    },
  }

  const libPath =
    process.env.RAS_LIBPYTHON ||
    "/home/iceory/miniconda3/lib/libpython3.13.so"
  const repoRoot =
    process.env.AGENT_RAS_ROOT ||
    "/home/iceory/work/agent-reliability/agent_ras"

  result.libPath = libPath
  result.libExists = existsSync(libPath)
  result.repoRoot = repoRoot

  try {
    result.steps.import_bun_ffi = { ok: true }
    const { symbols: py } = dlopen(libPath, {
      Py_Initialize: { args: [], returns: FFIType.void },
      Py_IsInitialized: { args: [], returns: FFIType.i32 },
      PyRun_SimpleString: { args: [FFIType.cstring], returns: FFIType.i32 },
      Py_FinalizeEx: { args: [], returns: FFIType.i32 },
    })
    result.steps.dlopen = { ok: true }

    py.Py_Initialize()
    result.steps.Py_Initialize = {
      ok: true,
      isInitialized: py.Py_IsInitialized(),
    }

    const rc1 = py.PyRun_SimpleString(
      Buffer.from('print("oc-plugin-ffi-ok", 1+1)\0'),
    )
    result.steps.simple_print = { ok: rc1 === 0, rc: rc1 }

    const importScript = `
import sys
sys.path.insert(0, ${JSON.stringify(repoRoot)})
import core
from core.config import AgentRASConfig
print("oc-plugin-core-ok", AgentRASConfig.__name__)
`
    const rc2 = py.PyRun_SimpleString(Buffer.from(importScript + "\0"))
    result.steps.import_core = { ok: rc2 === 0, rc: rc2 }

    try {
      py.Py_FinalizeEx()
      result.steps.finalize = { ok: true }
    } catch (e) {
      result.steps.finalize = { ok: false, error: String(e) }
    }
  } catch (e) {
    result.error = {
      message: e?.message || String(e),
      stack: e?.stack || null,
      name: e?.name || null,
    }
    log(`probe error: ${result.error.message}`)
  }

  try {
    mkdirSync(RAS_HOME, { recursive: true })
    writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8")
    log(`wrote ${OUT}`)
  } catch (e) {
    log(`write failed: ${e}`)
  }
  return result
}

const _probeResult = probe()
log(
  `probe finished simple=${_probeResult.steps?.simple_print?.ok} core=${_probeResult.steps?.import_core?.ok} err=${_probeResult.error?.message || ""}`,
)

export async function BunFfiProbePlugin() {
  return {}
}

export default BunFfiProbePlugin
