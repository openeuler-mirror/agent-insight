import assert from "node:assert/strict"
import test from "node:test"

process.env.AGENT_INSIGHT_UPLOADER_NO_MAIN = "1"

const uploaderPromise = import("../scripts/opencode_uploader_client.js")

test("opencode uploader: recognizes session.created properties.info.parentID", async () => {
  const uploader = await uploaderPromise
  const state = uploader.buildState([
    {
      kind: "event",
      payload: {
        type: "session.created",
        event: { properties: { info: { id: "ses_root", agent: "root" } } },
      },
    },
    {
      kind: "event",
      payload: {
        type: "session.created",
        event: { properties: { info: { id: "ses_child", parentID: "ses_root", agent: "worker" } } },
      },
    },
  ])

  assert.equal(state.sessionParent.get("ses_child"), "ses_root")
  assert.deepEqual(Array.from(state.children.get("ses_root") || []), ["ses_child"])
  assert.deepEqual(Array.from(state.sessions.keys()).filter((sid) => !state.sessionParent.get(sid)), ["ses_root"])
})

test("opencode uploader: infers child sessions from task tool output metadata", async () => {
  const uploader = await uploaderPromise
  const state = uploader.buildState([
    {
      kind: "event",
      payload: {
        type: "message.updated",
        event: {
          properties: {
            info: {
              id: "msg_root",
              sessionID: "ses_root",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
          },
        },
      },
    },
    {
      kind: "event",
      payload: {
        type: "message.part.updated",
        event: {
          properties: {
            part: {
              id: "part_task",
              messageID: "msg_root",
              sessionID: "ses_root",
              type: "tool",
              tool: "task",
              state: {
                status: "success",
                input: { subagent_type: "worker" },
                output: "<task_metadata>\nsession_id: ses_child\n</task_metadata>",
              },
            },
          },
        },
      },
    },
    {
      kind: "event",
      payload: {
        type: "message.updated",
        event: {
          properties: {
            info: {
              id: "msg_child",
              sessionID: "ses_child",
              role: "assistant",
              time: { created: 3, completed: 4 },
            },
          },
        },
      },
    },
    {
      kind: "event",
      payload: {
        type: "message.part.updated",
        event: {
          properties: {
            part: {
              id: "part_child_text",
              messageID: "msg_child",
              sessionID: "ses_child",
              type: "text",
              text: "child result",
            },
          },
        },
      },
    },
  ])

  assert.equal(state.sessionParent.get("ses_child"), "ses_root")
  assert.deepEqual(Array.from(state.sessions.keys()).filter((sid) => !state.sessionParent.get(sid)), ["ses_root"])

  const merged = uploader.mergeGraph(state, "ses_root")
  assert.ok(merged.some((m: any) => m.role === "subagent" && m.subagent_session_id === "ses_child"))
})

test("opencode uploader: merges repeated updates for the same task tool call by callID", async () => {
  const uploader = await uploaderPromise
  const state = uploader.buildState([
    {
      kind: "event",
      payload: {
        type: "message.updated",
        event: {
          properties: {
            info: {
              id: "msg_root",
              sessionID: "ses_root",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
          },
        },
      },
    },
    {
      kind: "event",
      payload: {
        type: "message.part.updated",
        event: {
          properties: {
            part: {
              id: "part_task_draft",
              callID: "call_task_1",
              messageID: "msg_root",
              sessionID: "ses_root",
              type: "tool",
              tool: "task",
              state: {
                status: "running",
                input: { subagent_type: "fuxi-sub", description: "构建文件系统故障诊断计划" },
              },
            },
          },
        },
      },
    },
    {
      kind: "event",
      payload: {
        type: "message.part.updated",
        event: {
          properties: {
            part: {
              id: "part_task_final",
              callID: "call_task_1",
              messageID: "msg_root",
              sessionID: "ses_root",
              type: "tool",
              tool: "task",
              state: {
                status: "success",
                input: { subagent_type: "fuxi-sub", description: "构建文件系统故障诊断计划" },
                output: "<task_metadata>\nsession_id: ses_child\n</task_metadata>",
              },
            },
          },
        },
      },
    },
  ])

  const messages = uploader.buildMessagesForSession(state, "ses_root")
  assert.equal(messages.length, 1)
  const toolCalls = messages[0]?.tool_calls
  assert.ok(Array.isArray(toolCalls), "messages[0].tool_calls 应该是数组")
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].id, "call_task_1")
  assert.equal(toolCalls[0].state, "success")
})

test("opencode uploader: recovers user input from text part when chat.message.messageID is null", async () => {
  const uploader = await uploaderPromise
  const state = uploader.buildState([
    // Newer opencode often fires the chat.message hook without a messageID, so
    // userTextByMsg can't be keyed to the message.
    { kind: "chat.message", sessionID: "ses_root", payload: { messageID: null, text: "nihao" } },
    // User message. On newer opencode info.system is null (not the system-prompt
    // string the old fallback relied on).
    {
      kind: "event",
      payload: {
        type: "message.updated",
        event: {
          properties: {
            info: { id: "msg_user", sessionID: "ses_root", role: "user", system: null, time: { created: 1 } },
          },
        },
      },
    },
    // The user's typed query reliably lives in the message's own text part.
    {
      kind: "event",
      payload: {
        type: "message.part.updated",
        event: {
          properties: {
            part: { id: "prt_user", messageID: "msg_user", sessionID: "ses_root", type: "text", text: "nihao" },
          },
        },
      },
    },
    // An assistant reply so the session looks complete.
    {
      kind: "event",
      payload: {
        type: "message.updated",
        event: {
          properties: {
            info: { id: "msg_asst", sessionID: "ses_root", role: "assistant", time: { created: 2, completed: 3 } },
          },
        },
      },
    },
    {
      kind: "event",
      payload: {
        type: "message.part.updated",
        event: {
          properties: {
            part: { id: "prt_asst", messageID: "msg_asst", sessionID: "ses_root", type: "text", text: "你好" },
          },
        },
      },
    },
  ])

  const messages = uploader.buildMessagesForSession(state, "ses_root")
  const user = messages.find((m: any) => m.role === "user")
  assert.ok(user, "应当存在 user 消息")
  assert.equal(user.content, "nihao", "messageID 缺失时仍应从 text part 还原用户输入")
})
