import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const adapterRoot = path.resolve('agent_fault_injection/platform_adapters/opencode')
const skillsRoot = path.resolve('agent_fault_injection/fault_inject/skills')

/** Load production hooks while substituting only the unavailable SDK tool registrar. */
async function loadPlugin(root: string) {
  cpSync(path.join(adapterRoot, 'lib'), path.join(root, 'lib'), { recursive: true })
  cpSync(path.join(adapterRoot, 'plugin'), path.join(root, 'plugin'), { recursive: true })
  const source = readFileSync(path.join(adapterRoot, 'plugin/agent-fault-injection.ts'), 'utf8')
    .replace('from "@opencode-ai/plugin"', 'from "./sdk-stub"')
  writeFileSync(path.join(root, 'plugin/agent-fault-injection.ts'), source)
  writeFileSync(path.join(root, 'plugin/sdk-stub.ts'), `
    export type Plugin = any
    export const tool = Object.assign((definition: any) => definition, {
      schema: { enum: () => ({ describe: () => ({}) }) },
    })
  `)
  const loaded = await import(pathToFileURL(path.join(root, 'plugin/agent-fault-injection.ts')).href)
  return loaded.AgentRasEvalPlugin || loaded.default.AgentRasEvalPlugin
}

for (const fault of ['skill-selection-conflict', 'tool-argument-error', 'skill-rule-conflict']) {
  test(`visible ${fault} loads before business execution and keeps rewrite counting intact`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'fi-plugin-visible-'))
    const recipe = JSON.parse(readFileSync(path.join(skillsRoot, fault, 'fault.json'), 'utf8'))
    const rawDir = path.join(root, 'raw')
    const values = {
      AGENT_FI_RUN_ID: `test-${fault}`,
      AGENT_FI_FAULT_SKILL: recipe.skill_name,
      AGENT_FI_RAW_DIR: rawDir,
      AGENT_FI_INJECTION_RUNTIME: JSON.stringify(recipe.injection.runtime || []),
    }
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.assign(process.env, values)
    try {
      const initialize = await loadPlugin(root)
      const hooks = await initialize({ directory: root })
      const title = { system: ['You are a title generator. You output ONLY a thread title.'] }
      await hooks['experimental.chat.system.transform']({ sessionID: 'title-session' }, title)
      assert.equal(title.system.length, 1)
      await hooks['chat.message'](
        { sessionID: 'judge-before-root', agent: 'ras-judge' },
        { message: { role: 'user' }, parts: [] },
      )
      const sessionID = 'visible-skill-session'
      const system = { system: [] as string[] }
      await hooks['experimental.chat.system.transform']({ sessionID }, system)
      assert.ok(system.system.join('\n').includes(`load the "${recipe.skill_name}" skill exactly once`))
      await hooks['experimental.chat.system.transform']({ sessionID }, system)
      assert.equal(system.system.length, 1)
      const reviewer = { system: ['Internal review instructions'] }
      await hooks['experimental.chat.system.transform']({ sessionID: 'ras-reviewer' }, reviewer)
      assert.deepEqual(reviewer.system, ['Internal review instructions'])
      await hooks['tool.execute.after'](
        { sessionID: 'ras-reviewer', tool: 'skill', args: { name: recipe.skill_name } },
        { output: 'internal skill result' },
      )

      if (recipe.injection.runtime.length) {
        let toolName = 'skill'
        let argumentsValue: Record<string, unknown> = { name: recipe.skill_name }
        const config = {
          provider: {
            fixture: {
              options: {
                fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                  assert.equal(String(input), 'https://provider.invalid/chat')
                  assert.ok(init?.body)
                  return new Response(JSON.stringify({
                  choices: [{
                    message: {
                      role: 'assistant',
                      tool_calls: [{
                        id: 'test-call',
                        type: 'function',
                        function: { name: toolName, arguments: JSON.stringify(argumentsValue) },
                      }],
                    },
                  }],
                  }), { headers: { 'content-type': 'application/json' } })
                },
              },
            },
          },
        }
        await hooks.config(config)
        const headers = { headers: {} }
        await hooks['chat.headers']({ sessionID }, headers)

        /** Pass a real provider response through the installed production fetch wrapper. */
        async function transformedArguments() {
          const response = await config.provider.fixture.options.fetch('https://provider.invalid/chat', {
            headers: headers.headers,
            body: JSON.stringify({
              tools: [{ type: 'function', function: { name: toolName } }],
            }),
          })
          const body = await response.json()
          return JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)
        }

        assert.deepEqual(await transformedArguments(), { name: recipe.skill_name })
        toolName = fault === 'skill-selection-conflict' ? 'skill' : 'order'
        argumentsValue = fault === 'skill-selection-conflict'
          ? { name: 'ras-code-review' }
          : { txt: 'a.txt' }
        const rewritten = await transformedArguments()
        assert.deepEqual(rewritten, fault === 'skill-selection-conflict'
          ? { name: 'ras-code-format' }
          : { txt: 'b.txt' })
        assert.deepEqual(await transformedArguments(), argumentsValue)

        if (fault === 'tool-argument-error') {
          await hooks.tool.order.execute(rewritten, { directory: root })
          const result = JSON.parse(readFileSync(path.join(root, 'tool-argument-error-output/result.json'), 'utf8'))
          assert.deepEqual(result.actual_arguments, { txt: 'b.txt' })
          assert.equal(result.tool_succeeded, true)
        }
      }

      const events = readFileSync(path.join(rawDir, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line))
      assert.equal(events.filter((event) => event.kind === 'fault.activation.requested').length, 1)
      assert.deepEqual(
        events.filter((event) => event.kind === 'run.session.bound').map((event) => event.payload.sessionID),
        [sessionID],
      )
      assert.equal(events.some((event) => event.payload?.sessionID === 'ras-reviewer'), false)
      const applied = events.filter((event) => event.kind === 'fault.injection.applied')
      assert.equal(applied.length, recipe.injection.runtime.length ? 1 : 0)
      if (applied.length) assert.equal(applied[0].payload.call_index, 1)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
}
