/**
 * koffi bridge → in-process ras_runtime.call (pi extension runtime).
 * Only used when agent_ras.service.transport === "inproc".
 *
 * Mechanical port of ../common/python_bridge.js (bun:ffi) onto koffi:
 * libc dlopen(RTLD_GLOBAL) makes libpython symbols globally visible so
 * extension modules (pydantic etc.) resolve Py* symbols without
 * LD_PRELOAD — plain `pi` works.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { RAS_RUNTIME_ROOT } from "../runtime_root.ts"

const RTLD_NOW = 2
const RTLD_GLOBAL = 0x100

export function insightRasDir(): string {
  if (process.env.AGENT_INSIGHT_RAS_HOME) return process.env.AGENT_INSIGHT_RAS_HOME
  const dataDir = process.env.AGENT_INSIGHT_DATA_DIR
  if (dataDir) return join(dataDir, "ras")
  return join(homedir(), ".agent-insight", "ras")
}

function loadServiceConfig(): Record<string, unknown> {
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
let _py: any = null
let _initError: string | null = null
let _callSequence = 0

// koffi must load synchronously (embedCall is sync); require() is provided
// by jiti in the pi extension runtime and absent in plain node ESM (tests),
// which yields the documented fail-open path.
function loadKoffi(): any {
  try {
    if (typeof require === "function") return require("koffi")
  } catch {
    return null
  }
  return null
}

function preloadLibpythonGlobal(koffi: any, libPath: string): void {
  const libcNames =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libc.dylib"]
      : ["libc.so.6", "libc.so"]
  let dlopenFunc: any = null
  let dlerrorFunc: any = null
  for (const name of libcNames) {
    try {
      const libc = koffi.load(name)
      dlopenFunc = libc.func("dlopen", "void *", ["const char *", "int"])
      dlerrorFunc = libc.func("dlerror", "const char *", [])
      break
    } catch {
      /* try next */
    }
  }
  if (!dlopenFunc) {
    throw new Error("libc dlopen unavailable for RTLD_GLOBAL preload")
  }
  const flags =
    process.platform === "darwin"
      ? RTLD_NOW | 0x8 /* RTLD_GLOBAL on macOS is often 0x8 */
      : RTLD_NOW | RTLD_GLOBAL
  const handle = dlopenFunc(libPath, flags)
  if (!handle) {
    let err = "unknown"
    try {
      err = dlerrorFunc?.() || err
    } catch {
      /* ignore */
    }
    throw new Error(`RTLD_GLOBAL dlopen(${libPath}) failed: ${err}`)
  }
}

export function embedReady(): boolean {
  if (_ready) return true
  if (_initError) return false
  return ensureInit()
}

export function embedInitError(): string | null {
  return _initError
}

function ensureInit(): boolean {
  if (_ready) return true
  if (_initError) return false

  const koffi = loadKoffi()
  if (!koffi) {
    _initError = "koffi unavailable: install dependencies in the pi extensions directory"
    console.error("[insight-ras] inproc init failed:", _initError)
    return false
  }

  const service = loadServiceConfig() as any
  const libPath = service.libpython || process.env.RAS_LIBPYTHON || ""
  const pythonHome = service.python_home || process.env.PYTHONHOME || ""
  const repoRoot = service.repo_root || process.env.AGENT_RAS_ROOT || RAS_RUNTIME_ROOT || ""
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
    preloadLibpythonGlobal(koffi, libPath)

    const py = koffi.load(libPath)
    const Py_Initialize = py.func("Py_Initialize", "void", [])
    const Py_IsInitialized = py.func("Py_IsInitialized", "int", [])
    const PyRun_SimpleString = py.func("PyRun_SimpleString", "int", ["const char *"])
    const PyEval_SaveThread = py.func("PyEval_SaveThread", "void *", [])
    const PyGILState_Ensure = py.func("PyGILState_Ensure", "int", [])
    const PyGILState_Release = py.func("PyGILState_Release", "void", ["int"])

    const alreadyInitialized = Boolean(Py_IsInitialized())
    if (!alreadyInitialized) {
      Py_Initialize()
    }
    const boot = `
import sys
sys.path.insert(0, ${JSON.stringify(pythonPackages || ".")})
sys.path.insert(0, ${JSON.stringify(repoRoot || ".")})
from ras_runtime import call as _ras_runtime_call
`
    let gilState: number | null = null
    if (alreadyInitialized) gilState = PyGILState_Ensure()
    let rc: number
    try {
      rc = PyRun_SimpleString(boot)
    } finally {
      if (alreadyInitialized) PyGILState_Release(gilState)
      else PyEval_SaveThread()
    }
    if (rc !== 0) {
      _initError = "failed to import ras_runtime inside embedded Python"
      console.error("[insight-ras] inproc init failed:", _initError)
      return false
    }
    _py = { PyRun_SimpleString, PyGILState_Ensure, PyGILState_Release }
    _ready = true
    return true
  } catch (e: any) {
    _initError = e?.message || String(e)
    console.error("[insight-ras] inproc init failed:", _initError)
    return false
  }
}

/**
 * Call ras_runtime.call via inproc bridge.
 *
 * PyRun_SimpleString does not expose the Python return value, so the bridge
 * uses a per-call result file. A unique path prevents concurrent pi sessions
 * or processes from reading each other's results.
 */
export function embedCall(op: string, sessionId: string, payload: unknown): unknown | null {
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
  const script = `
from ras_runtime import call as _ras_runtime_call
_out = _ras_runtime_call(${opLit}, ${sidLit}, ${payLit})
open(${JSON.stringify(outPath)}, "w", encoding="utf-8").write(_out)
`
  const gilState = _py.PyGILState_Ensure()
  let rc: number
  try {
    rc = _py.PyRun_SimpleString(script)
  } finally {
    _py.PyGILState_Release(gilState)
  }
  if (rc !== 0) {
    console.error("[insight-ras] inproc call failed op=", op)
    return null
  }
  try {
    if (!existsSync(outPath)) return null
    return JSON.parse(readFileSync(outPath, "utf8"))
  } catch (e: any) {
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
