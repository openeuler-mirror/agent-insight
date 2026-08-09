/**
 * bun:ffi bridge → in-process ras_runtime.call (OpenCode plugin runtime).
 * Only used when agent_ras.service.transport === "inproc".
 *
 * Loads libpython with libc dlopen(RTLD_GLOBAL) so extension modules
 * (pydantic etc.) resolve Py* symbols without requiring LD_PRELOAD /
 * a custom launcher — plain `opencode` works.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

/** Linux dlfcn.h: RTLD_LAZY=1, RTLD_NOW=2, RTLD_GLOBAL=0x100 */
const RTLD_NOW = 2
const RTLD_GLOBAL = 0x100

function insightRasDir() {
  if (process.env.AGENT_INSIGHT_RAS_HOME) return process.env.AGENT_INSIGHT_RAS_HOME
  const dataDir = process.env.AGENT_INSIGHT_DATA_DIR
  if (dataDir) return join(dataDir, "ras")
  return join(homedir(), ".agent-insight", "ras")
}

function loadServiceConfig() {
  try {
    const p = join(insightRasDir(), "config.json")
    if (!existsSync(p)) return {}
    const cfg = JSON.parse(readFileSync(p, "utf8"))
    return cfg?.agent_ras?.service || {}
  } catch {
    return {}
  }
}

let _ready = false
let _py = null
let _initError = null
let _callSequence = 0

function cstr(s) {
  return Buffer.from(String(s) + "\0")
}

/**
 * Make libpython symbols globally visible before importing C extensions.
 * Bun's dlopen alone is local-binding; without this, `_opcode.so` fails
 * with undefined symbol: PyList_New unless the process was started with
 * LD_PRELOAD=libpython.
 */
function preloadLibpythonGlobal(dlopen, FFIType, libPath) {
  const libcNames =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libc.dylib"]
      : ["libc.so.6", "libc.so"]
  let libc = null
  for (const name of libcNames) {
    try {
      libc = dlopen(name, {
        dlopen: {
          args: [FFIType.cstring, FFIType.i32],
          returns: FFIType.ptr,
        },
        dlerror: { args: [], returns: FFIType.cstring },
      })
      break
    } catch {
      /* try next */
    }
  }
  if (!libc?.symbols?.dlopen) {
    throw new Error("libc dlopen unavailable for RTLD_GLOBAL preload")
  }
  const flags =
    process.platform === "darwin"
      ? RTLD_NOW | 0x8 /* RTLD_GLOBAL on macOS is often 0x8 */
      : RTLD_NOW | RTLD_GLOBAL
  const handle = libc.symbols.dlopen(cstr(libPath), flags)
  if (!handle || handle === 0n || handle === 0) {
    let err = "unknown"
    try {
      err = libc.symbols.dlerror?.() || err
    } catch {
      /* ignore */
    }
    throw new Error(`RTLD_GLOBAL dlopen(${libPath}) failed: ${err}`)
  }
}

export function embedReady(svc = null) {
  if (_ready) return true
  if (_initError) return false
  return ensureInit(svc)
}

export function embedInitError() {
  return _initError
}

function ensureInit(svc = null) {
  if (_ready) return true
  if (_initError) return false

  let dlopen
  let FFIType
  try {
    // Dynamic so http transport never loads bun:ffi.
    ;({ dlopen, FFIType } = require("bun:ffi"))
  } catch (e) {
    _initError = `bun:ffi unavailable: ${e?.message || e}`
    console.error("[insight-ras] inproc init failed:", _initError)
    return false
  }

  const service = svc || loadServiceConfig()
  const libPath = service.libpython || process.env.RAS_LIBPYTHON || ""
  const pythonHome = service.python_home || process.env.PYTHONHOME || ""
  const repoRoot = service.repo_root || process.env.AGENT_RAS_ROOT || ""
  const pythonPackages =
    service.python_packages ||
    (repoRoot ? join(repoRoot, ".python-packages") : "")

  if (!libPath || !existsSync(libPath)) {
    _initError = `libpython not found: ${libPath || "(empty)"}`
    console.error("[insight-ras] inproc init failed:", _initError)
    return false
  }

  try {
    if (pythonHome) process.env.PYTHONHOME = pythonHome
    if (repoRoot) {
      const cur = process.env.PYTHONPATH || ""
      const paths = [pythonPackages, repoRoot, ...cur.split(delimiter)].filter(Boolean)
      process.env.PYTHONPATH = [...new Set(paths)].join(delimiter)
    }

    mkdirSync(insightRasDir(), { recursive: true })

    // Critical: global symbol visibility without LD_PRELOAD.
    preloadLibpythonGlobal(dlopen, FFIType, libPath)

    const { symbols: py } = dlopen(libPath, {
      Py_Initialize: { args: [], returns: FFIType.void },
      Py_IsInitialized: { args: [], returns: FFIType.i32 },
      PyRun_SimpleString: { args: [FFIType.cstring], returns: FFIType.i32 },
    })
    if (!py.Py_IsInitialized()) {
      py.Py_Initialize()
    }
    const boot = `
import sys
sys.path.insert(0, ${JSON.stringify(pythonPackages || ".")})
sys.path.insert(0, ${JSON.stringify(repoRoot || ".")})
from ras_runtime import call as _ras_runtime_call
`
    const rc = py.PyRun_SimpleString(cstr(boot))
    if (rc !== 0) {
      _initError = "failed to import ras_runtime inside embedded Python"
      console.error("[insight-ras] inproc init failed:", _initError)
      return false
    }
    _py = py
    _ready = true
    return true
  } catch (e) {
    _initError = e?.message || String(e)
    console.error("[insight-ras] inproc init failed:", _initError)
    return false
  }
}

/**
 * Call ras_runtime.call via inproc bridge.
 *
 * PyRun_SimpleString does not expose the Python return value, so the bridge
 * uses a per-call result file. A unique path prevents concurrent OpenCode
 * sessions or processes from reading each other's results.
 */
export function embedCall(op, sessionId, payload) {
  if (!ensureInit()) return null
  const payloadJson = JSON.stringify(payload || {})
  const opLit = JSON.stringify(String(op))
  const sidLit = JSON.stringify(String(sessionId || ""))
  const payLit = JSON.stringify(payloadJson)
  const callRoot = join(insightRasDir(), "calls")
  mkdirSync(callRoot, { recursive: true })
  _callSequence += 1
  const outPath = join(
    callRoot,
    `result-${process.pid}-${Date.now()}-${_callSequence}.json`,
  )
  const scriptFile = `
from ras_runtime import call as _ras_runtime_call
_out = _ras_runtime_call(${opLit}, ${sidLit}, ${payLit})
open(${JSON.stringify(outPath)}, "w", encoding="utf-8").write(_out)
`
  const rc = _py.PyRun_SimpleString(cstr(scriptFile))
  if (rc !== 0) {
    console.error("[insight-ras] inproc call failed op=", op)
    return null
  }
  try {
    if (!existsSync(outPath)) return null
    return JSON.parse(readFileSync(outPath, "utf8"))
  } catch (e) {
    console.error("[insight-ras] inproc parse failed:", e?.message || e)
    return null
  } finally {
    try {
      unlinkSync(outPath)
    } catch {
      /* ignore */
    }
  }
}

export default { embedCall, embedReady, embedInitError }
