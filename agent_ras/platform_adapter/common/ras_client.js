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

/**
 * Shared in-process RAS client for JavaScript hosts.
 *
 * Agent RAS no longer starts or talks to a local HTTP service. JavaScript
 * hosts call ras_runtime through the bun:ffi bridge; Python hosts use the
 * matching in-process client in ras_client.py.
 */

let bridgePromise = null

async function getBridge() {
  if (!bridgePromise) bridgePromise = import("./python_bridge.js")
  return bridgePromise
}

export function createRasClient(options = {}) {
  const enabled = options.enabled !== false
  let ready = false
  let onActions = options.onActions || null

  async function call(op, sessionId, payload = {}) {
    if (!enabled) return null
    try {
      const bridge = await getBridge()
      if (!ready && !bridge.embedReady()) return null
      ready = true
      return bridge.embedCall(op, sessionId, payload)
    } catch (error) {
      ready = false
      console.error(
        `[insight-ras] inproc ${op} failed:`,
        error?.message || String(error),
      )
      return null
    }
  }

  async function dispatchActions(result, sessionId) {
    if (onActions && result?.actions?.length) {
      await onActions(sessionId, result.actions, result.anomaly)
    }
    return result
  }

  return {
    baseUrl: null,
    enabled,
    transport: "inproc",
    async ensure() {
      if (!enabled) return false
      const bridge = await getBridge()
      ready = bridge.embedReady()
      return ready
    },
    async hello(sessionId, platform, config) {
      return call("hello", sessionId, { platform, config: config || {} })
    },
    async observe(sessionId, payload) {
      return dispatchActions(
        await call("observe", sessionId, payload || {}),
        sessionId,
      )
    },
    async reset(sessionId) {
      if (!ready) return
      await call("reset", sessionId, {})
    },
    async reportActionResult(sessionId, result) {
      const out = await call("action_result", sessionId, {
        action: result?.action,
        ok: Boolean(result?.ok),
        channel: result?.channel,
        error: result?.error,
        message: result?.message,
        trace_anchor: result?.trace_anchor,
        delivery_anchor: result?.delivery_anchor,
      })
      return Boolean(out?.ok)
    },
    async flush(sessionId, timeoutMs = 2500) {
      if (!ready) return null
      return call("flush", sessionId, { timeout_ms: timeoutMs })
    },
    async skillResult(sessionId, payload) {
      return dispatchActions(
        await call("skill_result", sessionId, payload || {}),
        sessionId,
      )
    },
    async bye(sessionId) {
      if (!ready) return
      await call("flush", sessionId, { timeout_ms: 2500 })
      await call("bye", sessionId, {})
    },
    setOnActions(handler) {
      onActions = handler
    },
  }
}

export default createRasClient
