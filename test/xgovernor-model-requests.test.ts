import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { XGovernorExecutionBackend } = require('../services/executor/src/xgovernor/backend.cjs')
const { normalizeExecutionConfig, describeProfile } = require('../packages/benchmark-protocol/execution.cjs')
const { atomicWriteJson } = require('../services/executor/src/index.cjs')
const { validateResolved } = require('../services/executor/src/xgovernor/model-resolver.cjs')

for (const kind of ['pi', 'xiaoo']) {
  test(`${kind} sends resolved capabilities on open and retains per-turn reasoning after reloading its handle`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-model-wire-'))
    let close: (() => Promise<unknown>) | undefined
    t.after(async () => { try { await close?.() } finally { fs.rmSync(directory, { recursive: true, force: true }) } })
    const platform = kind === 'pi' ? 'pi-agent' : 'xiaoo'
    const config = normalizeExecutionConfig({ profiles: { 'xgovernor-local-docker': {
      sourceRevision: 'a'.repeat(40), runtimes: { [platform]: {
        kind, namespace: kind, agents: [platform], workerExecutable: '/test/worker',
        ...(kind === 'pi' ? { executable: '/test/pi', extensionDirectory: '/test/extension' } : {}),
      } },
    } } })
    const profile = describeProfile('xgovernor-local-docker', config.profiles['xgovernor-local-docker'])
    const caps = kind === 'pi' ? { reasoning: true, input: ['text'], context_window: 1048576, max_tokens: 128000 } : { max_tokens: 128000 }
    const resolved = validateResolved({ provider: 'custom', model: 'selected', api: 'openai-completions', apiBase: 'https://model.example/v1', capabilities: caps, ...(kind === 'xiaoo' ? { reasoningEffort: 'high' } : {}) }, 'private-case-secret')
    const imageId = `sha256:${'b'.repeat(64)}`
    const runId = `run_wire_${kind}`
    const revision = 'a'.repeat(40)
    const task = {
      context: { runId }, benchmark: { key: 'swe-bench' }, task: { instruction: 'fix the issue', benchmarkPayload: { instanceId: 'example__project-1' } },
      workspace: { provider: 'git', revision, repository: 'https://github.com/example/project.git' },
      policy: { network: 'deny' }, agentConfig: { platform, agent: platform, model: 'custom/selected', timeoutSeconds: 60 },
      execution: { profile, environment: { kind: 'oci-image', image: 'swebench/sweb.eval.x86_64.example_1776_project-1:latest', arch: 'amd64', workspaceRoot: '/testbed' } },
    }
    const requests: Array<{ url: string; payload: any }> = []
    const environments: Record<string, string>[] = []
    let alive = false
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null })
    const backend = new XGovernorExecutionBackend({
      config, baseDir: directory, atomicWriteJson,
      resolveModel: async () => resolved,
      probe: () => ({ profiles: [{ profile, ready: true }] }),
      spawnImpl(_file: string, _args: string[], options: { env: Record<string, string> }) {
        environments.push(options.env)
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
      async processRunner(_file: string, args: string[]) {
        const command = args.slice(2)
        if (command[0] === 'info') return { stdout: 'x86_64' }
        if (command[0] === 'image') return { stdout: command.includes('--format') ? `[]|${imageId}` : JSON.stringify([{ Id: imageId, Architecture: 'amd64', Os: 'linux', RepoDigests: [] }]) }
        if (command[0] === 'ps') return { stdout: alive ? 'test-container' : '' }
        if (command[0] === 'inspect') return { stdout: JSON.stringify([{ Id: 'test-container', Image: imageId, Mounts: [], Config: { User: '10001:10001', WorkingDir: '/testbed' }, HostConfig: { NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 4096 * 1024 ** 2, NanoCpus: 2e9, PidsLimit: 512 } }]) }
        throw new Error('Unexpected Docker command')
      },
      async fetchImpl(url: string, options: { body?: string }) {
        const payload = options.body ? JSON.parse(options.body) : undefined
        requests.push({ url, payload })
        if (url.endsWith('/sessions/open')) {
          alive = true
          return Response.json({ runtime_id: payload.runtime_id, isolation: { boundary: 'container', network: 'isolated' } })
        }
        if (url.endsWith('/sessions/exec')) return Response.json({ exit_code: 0, stdout: payload.command[1] === 'rev-parse' ? revision : payload.command[1] === 'remote' ? task.workspace.repository : '', stderr: '', timed_out: false })
        if (url.endsWith('/sessions/turns')) return new Response(null, { status: 503 })
        if (url.endsWith('/sessions/close')) { alive = false; child.exitCode = 0 }
        return Response.json({})
      },
    })
    const context = { runId, async persist() {} }
    const prepared = await backend.prepare(task, context)
    close = () => backend.close(prepared)
    const opened = requests.find(item => item.url.endsWith('/sessions/open'))!.payload
    assert.deepEqual(opened.llm.capabilities, caps)
    assert.equal(opened.llm.model, 'selected')
    assert.equal(opened.llm.api_key_env, 'AGENT_INSIGHT_CASE_MODEL_KEY')
    assert.equal(environments[0].AGENT_INSIGHT_CASE_MODEL_KEY, 'private-case-secret')
    assert.equal(JSON.stringify(prepared).includes('private-case-secret'), false)
    const persisted = JSON.parse(fs.readFileSync(path.join(prepared.opaque.directory, 'lease.json'), 'utf8'))
    resolved.model.reasoningEffort = 'off'
    await assert.rejects(backend.runAgent({ ...prepared, opaque: persisted }, { platform, input: 'fix the issue' }, context), /返回 HTTP 503/)
    const turns = requests.filter(item => item.url.endsWith('/sessions/turns'))
    assert.equal(turns.length, 1)
    assert.equal(turns[0].payload.reasoning_effort, kind === 'xiaoo' ? 'high' : undefined)
    assert.equal(JSON.stringify(requests).includes('private-case-secret'), false)
    assert.equal(fs.readFileSync(path.join(prepared.opaque.directory, 'lease.json'), 'utf8').includes('private-case-secret'), false)
  })
}
