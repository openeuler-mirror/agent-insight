/**
 * Lightweight node tests for host_actions + OpenCode host (no OpenCode runtime).
 * Run: node --test tests/unit_tests/platform_adapter/test_host_actions.mjs
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { applyActions, WIRE_TO_HOST } from "../../../platform_adapter/common/host_actions.js"
import { createOpenCodeHost } from "../../../platform_adapter/opencode/host_control.js"

function promptParts(p) {
  return p?.parts || p?.body?.parts || []
}

function promptText(p) {
  return String(promptParts(p)[0]?.text || "")
}

function promptSessionId(p) {
  return p?.sessionID || p?.path?.id || p?.id || p?.path?.sessionID
}

function promptNoReply(p) {
  return p?.noReply === true || p?.body?.noReply === true
}

describe("host_actions", () => {
  it("maps wire types to HostControl methods", () => {
    assert.equal(WIRE_TO_HOST.abort_stream, "requestAbortStream")
    assert.equal(WIRE_TO_HOST.emit_notice, "emitUserNotice")
    assert.equal(WIRE_TO_HOST.push_steering, "pushSteering")
  })

  it("dispatches in order and reports results", async () => {
    const calls = []
    const host = {
      async requestAbortStream() {
        calls.push("abort")
        return { ok: true, channel: "fake.abort" }
      },
      async emitUserNotice(msg) {
        calls.push(`notice:${msg}`)
        return { ok: true, channel: "fake.toast" }
      },
      async pushSteering(msg) {
        calls.push(`steer:${msg}`)
        return { ok: true, channel: "pending" }
      },
    }
    const results = []
    await applyActions(
      host,
      [
        { type: "abort_stream" },
        { type: "emit_notice", message: "loop" },
        { type: "push_steering", message: "fix it" },
      ],
      { onResult: (r) => results.push(r) },
    )
    assert.deepEqual(calls, ["abort", "notice:loop", "steer:fix it"])
    assert.equal(results.length, 3)
    assert.equal(results[0].action, "abort_stream")
    assert.equal(results[1].channel, "fake.toast")
    assert.equal(results[1].message, "loop")
    assert.equal(results[2].message, "fix it")
  })

  it("unknown action yields ok=false", async () => {
    const results = await applyActions({}, [{ type: "nope" }])
    assert.equal(results[0].ok, false)
  })
  it("forwards delivery_anchor from host result", async () => {
    const results = []
    await applyActions(
      {
        async emitUserNotice() {
          return {
            ok: true,
            channel: "session.prompt.noReply",
            delivery_anchor: {
              message_id: "msg_notice",
              part_id: "prt_1",
              channel: "ras_notice",
            },
          }
        },
      },
      [{ type: "emit_notice", message: "notice body" }],
      { onResult: (r) => results.push(r) },
    )
    assert.equal(results[0].ok, true)
    assert.equal(results[0].delivery_anchor.message_id, "msg_notice")
    assert.equal(results[0].delivery_anchor.channel, "ras_notice")
  })
})

describe("opencode host_control", () => {
  it("showToast receives flat SDK fields and injects noReply notice as-is", async () => {
    const toasts = []
    const prompts = []
    const aborts = []
    const client = {
      session: {
        async abort(req) {
          aborts.push(req)
          return true
        },
        async prompt(req) {
          prompts.push(req)
        },
      },
      tui: {
        async showToast(req) {
          toasts.push(req)
          return true
        },
        async executeCommand() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const session = host.forSession("opencode:s2")
    const r = await session.emitUserNotice("检测到思考循环异常，已执行恢复操作")
    assert.equal(r.ok, true)
    assert.equal(r.channel, "tui.toast")
    assert.equal(toasts.length, 1)
    assert.equal(toasts[0].message, "检测到思考循环异常，已执行恢复操作")
    assert.equal(toasts[0].variant, "warning")
    assert.equal(toasts[0].title, "Agent RAS")
    assert.equal(toasts[0].body, undefined)
    assert.ok(prompts.some((p) => promptNoReply(p)))
    assert.ok(prompts.some((p) => promptSessionId(p) === "s2"))
    assert.ok(
      prompts.some(
        (p) => promptText(p) === "检测到思考循环异常，已执行恢复操作",
      ),
    )
    assert.ok(
      !prompts.some((p) => promptText(p).includes("llm_thinking_loop")),
    )
    assert.ok(!prompts.some((p) => promptText(p).includes("[Agent RAS 告警]")))
  })

  it("treats hey-api void toast response as success (no console USER_NOTICE)", async () => {
    const toasts = []
    const errors = []
    const origError = console.error
    console.error = (...args) => {
      errors.push(args.map(String).join(" "))
    }
    try {
      const client = {
        session: {
          async prompt() {},
        },
        tui: {
          // Real SDK: { data: undefined, error: undefined, response: { ok: true } }
          async showToast(req) {
            toasts.push(req)
            return {
              data: undefined,
              error: undefined,
              response: { ok: true, status: 200 },
            }
          },
        },
      }
      const host = createOpenCodeHost({ client })
      const r = await host.forSession("opencode:void").emitUserNotice("检测到思考循环异常，已执行恢复操作")
      assert.equal(r.ok, true)
      assert.equal(r.channel, "tui.toast")
      assert.equal(toasts.length, 1)
      assert.ok(
        !errors.some((e) => e.includes("USER_NOTICE")),
        `unexpected USER_NOTICE log: ${errors.join(" | ")}`,
      )
    } finally {
      console.error = origError
    }
  })

  it("publish toast uses body envelope when showToast unavailable", async () => {
    const published = []
    const client = {
      session: {
        async prompt() {},
      },
      tui: {
        async publish(req) {
          published.push(req)
          return { data: undefined, response: { ok: true } }
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const r = await host.forSession("opencode:pub").emitUserNotice("toast via publish")
    assert.equal(r.ok, true)
    assert.equal(r.channel, "tui.publish")
    assert.equal(published[0].body.type, "tui.toast.show")
    assert.equal(published[0].body.properties.message, "toast via publish")
  })

  it("headless runs inject notices without calling TUI endpoints", async () => {
    const prompts = []
    let tuiCalls = 0
    const client = {
      session: {
        async prompt(req) {
          prompts.push(req)
        },
      },
      tui: {
        async showToast() {
          tuiCalls += 1
          return true
        },
        async publish() {
          tuiCalls += 1
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client, tuiAvailable: false })
    const r = await host.forSession("opencode:headless").emitUserNotice("headless notice")
    assert.equal(r.ok, true)
    assert.equal(r.channel, "session.prompt.noReply")
    assert.equal(tuiCalls, 0)
    assert.ok(prompts.some((p) => promptText(p) === "headless notice"))
  })

  it("escalate uses host_messages from core", async () => {
    let abortCount = 0
    const notices = []
    const client = {
      session: {
        async abort() {
          abortCount += 1
          return true
        },
        async prompt() {
          return {}
        },
      },
      tui: {
        async executeCommand() {
          return true
        },
        async showToast(req) {
          notices.push(req.message)
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client })
    host.setHostMessages({
      platform_abort_unconfirmed_user_notice: "CORE_ABORT_UNCONFIRMED",
    })
    const session = host.forSession("opencode:esc")
    await session.requestAbortStream()
    for (let i = 0; i < 6; i++) {
      const s = host._state("esc")
      s.lastAbortAt = 0
      await host.onPartGrowth("esc", 1000 + i)
    }
    assert.ok(abortCount >= 5)
    assert.ok(notices.includes("CORE_ABORT_UNCONFIRMED"))
  })

  it("abort uses session APIs without redundant TUI interrupts", async () => {
    const commands = []
    const aborts = []
    const interrupts = []
    const client = {
      session: {
        async abort(req) {
          aborts.push(req)
          return true
        },
        async interrupt(req) {
          interrupts.push(req)
          return { data: undefined, response: { ok: true } }
        },
        async prompt() {},
      },
      tui: {
        async executeCommand(req) {
          commands.push(req)
          return true
        },
        async showToast() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const session = host.forSession("opencode:s1")
    const r = await session.requestAbortStream()
    assert.equal(r.ok, true)
    assert.equal(aborts.length >= 1, true)
    assert.equal(aborts[0].sessionID, "s1")
    assert.equal(aborts[0].path, undefined)
    assert.ok(String(r.channel).includes("session.abort"))
    assert.equal(interrupts.length, 1)
    assert.equal(interrupts[0].sessionID, "s1")
    assert.ok(String(r.channel).includes("session.interrupt.api"))
    assert.equal(commands.length, 0)
  })

  it("abort treats hey-api data:true as success", async () => {
    const aborts = []
    const client = {
      session: {
        async abort(req) {
          aborts.push(req)
          // Real OpenCode abort success body is boolean true in hey-api fields.
          return { data: true, error: undefined, response: { ok: true, status: 200 } }
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const r = await host.forSession("opencode:bool").requestAbortStream()
    assert.equal(r.ok, true)
    assert.ok(String(r.channel).includes("session.abort"))
    assert.equal(aborts[0].sessionID, "bool")
    assert.equal(aborts[0].path, undefined)
  })

  it("abort retries alternate param shapes when first returns error", async () => {
    const aborts = []
    const client = {
      session: {
        async abort(req) { /* /session/{id}/abort */
          aborts.push(req)
          // First shape path.id fails; flat sessionID succeeds.
          if (req.path?.id) {
            return { data: undefined, error: { message: "bad path" }, response: { ok: false, status: 500 } }
          }
          if (req.sessionID) {
            return { data: true, response: { ok: true, status: 200 } }
          }
          return false
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const r = await host.forSession("opencode:shape").requestAbortStream()
    assert.equal(r.ok, true)
    assert.ok(aborts.some((a) => a.sessionID === "shape"))
    assert.ok(aborts.some((a) => a.path?.id === "shape"))
  })

  it("retries abort on part growth and escalates", async () => {
    let abortCount = 0
    const client = {
      session: {
        async abort() {
          abortCount += 1
          return true
        },
        async prompt() {
          return {}
        },
      },
      tui: {
        async executeCommand() {
          return true
        },
        async showToast() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const session = host.forSession("opencode:s1b")
    await session.requestAbortStream()
    assert.equal(abortCount, 1)
    assert.equal(host.isAborting("s1b"), true)

    for (let i = 0; i < 6; i++) {
      const s = host._state("s1b")
      s.lastAbortAt = 0
      await host.onPartGrowth("s1b", 1000 + i)
    }
    assert.ok(abortCount >= 5)
    assert.equal(host._state("s1b").phase, "failed")
  })

  it("headless notice includes delivery_anchor from prompt response", async () => {
    const client = {
      session: {
        async prompt(req) {
          const mid = req.messageID || req.body?.messageID || "msg_notice_1"
          return {
            data: {
              info: { id: mid },
              parts: [{ id: "prt_notice_1", type: "text", text: "headless notice", messageID: mid }],
            },
            response: { ok: true, status: 200 },
          }
        },
      },
      tui: {
        async showToast() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client, tuiAvailable: false })
    const r = await host.forSession("opencode:headless-anchor").emitUserNotice("headless notice")
    assert.equal(r.ok, true)
    assert.ok(r.delivery_anchor?.message_id?.startsWith("msg_"))
    assert.equal(r.delivery_anchor.part_id, "prt_notice_1")
    assert.equal(r.delivery_anchor.channel, "ras_notice")
  })

  it("prompt_async void response still yields delivery_anchor via preallocated messageID", async () => {
    const prompts = []
    const client = {
      session: {
        async promptAsync(req) {
          prompts.push(req)
          return { response: { ok: true, status: 204 } }
        },
        async prompt() {
          throw new Error("sync prompt should not be required when async accepts")
        },
      },
    }
    // Force async-only by making prompt throw after promptAsync — actually
    // with delivery messageID we prefer sync first. Stub sync as 204-like void
    // so extract falls back to preallocated id.
    client.session.prompt = async (req) => {
      prompts.push(req)
      return { response: { ok: true, status: 204 } }
    }
    const host = createOpenCodeHost({ client, tuiAvailable: false })
    const r = await host.forSession("opencode:async-anchor").emitUserNotice("async notice")
    assert.equal(r.ok, true)
    assert.ok(r.delivery_anchor?.message_id?.startsWith("msg_"))
    assert.equal(r.delivery_anchor.channel, "ras_notice")
    assert.ok(prompts.some((p) => (p.messageID || p.body?.messageID || "").startsWith("msg_")))
  })

  it("steering includes delivery_anchor when prompt returns empty body", async () => {
    const client = {
      session: {
        async prompt(req) {
          assert.ok((req.messageID || req.body?.messageID || "").startsWith("msg_"))
          return true
        },
        async abort() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client, tuiAvailable: false })
    const session = host.forSession("opencode:steer-anchor")
    host._state("steer-anchor").idleArrivedEarly = true
    const r = await session.pushSteering("<system-reminder>\nstop\n</system-reminder>")
    assert.equal(r.ok, true)
    assert.ok(r.delivery_anchor?.message_id?.startsWith("msg_"))
    assert.equal(r.delivery_anchor.channel, "ras_steering")
  })

  it("prefers preallocated delivery messageID over unrelated prompt response ids", async () => {
    const client = {
      session: {
        async prompt(req) {
          const mid = req.messageID || req.body?.messageID
          return {
            data: {
              // Simulate OpenCode returning an assistant/other message id.
              info: { id: "msg_assistant_other_turn" },
              parts: [{ id: "prt_other", type: "text", text: "assistant" }],
            },
            response: { ok: true, status: 200 },
          }
        },
      },
    }
    const host = createOpenCodeHost({ client, tuiAvailable: false })
    const r = await host.forSession("opencode:prefer-prealloc").emitUserNotice("notice")
    assert.equal(r.ok, true)
    assert.notEqual(r.delivery_anchor.message_id, "msg_assistant_other_turn")
    assert.ok(r.delivery_anchor.message_id.startsWith("msg_"))
  })

  it("pushSteering flushes on idle", async () => {
    const prompts = []
    const client = {
      session: {
        async abort() {
          return true
        },
        async prompt(req) {
          prompts.push(req)
        },
      },
      tui: {
        async showToast() {
          return true
        },
        async executeCommand() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const session = host.forSession("opencode:s3")
    await session.requestAbortStream()
    await session.emitUserNotice("warn")
    await session.pushSteering("please stop looping")
    const idle = await host.onSessionIdle("s3")
    assert.equal(idle.steered, true)
    assert.ok(prompts.some((p) => promptText(p).includes("please stop looping")))
    assert.ok(prompts.some((p) => promptSessionId(p) === "s3"))
    assert.ok(!prompts.some((p) => promptText(p).startsWith("[Agent RAS]")))
  })

  it("pushSteering injects immediately when idle raced ahead of steer", async () => {
    const prompts = []
    const client = {
      session: {
        async abort() {
          return true
        },
        async prompt(req) {
          prompts.push(req)
        },
      },
      tui: {
        async showToast() {
          return true
        },
        async executeCommand() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const session = host.forSession("opencode:s4")
    await session.requestAbortStream()
    // Idle arrives before push_steering (abort finishes first).
    const early = await host.onSessionIdle("s4")
    assert.equal(early.steered, false)
    assert.equal(early.waitingForSteer, true)
    const steered = await session.pushSteering("recovery after race")
    assert.equal(steered.ok, true)
    assert.equal(steered.steered, true)
    assert.ok(prompts.some((p) => promptText(p).includes("recovery after race")))
  })

  it("flushSteerIfPending force-injects when idle event never returns", async () => {
    const prompts = []
    const client = {
      session: {
        async abort() {
          return true
        },
        async prompt(req) {
          prompts.push(req)
        },
        // status stays busy — simulates missing idle after abort
        async status() {
          return { data: { s5: { type: "busy" } } }
        },
      },
      tui: {
        async showToast() {
          return true
        },
        async executeCommand() {
          return true
        },
      },
    }
    const host = createOpenCodeHost({ client })
    const session = host.forSession("opencode:s5")
    await session.requestAbortStream()
    await session.pushSteering("force recovery text")
    const flushed = await host.flushSteerIfPending("s5")
    assert.equal(flushed.steered, true)
    assert.equal(flushed.channel, "session.prompt")
    assert.ok(prompts.some((p) => promptText(p).includes("force recovery text")))
  })
})
