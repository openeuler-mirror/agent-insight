import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/** Exercise independent CLI uploads against a real slow HTTP sink, without a model. */
test('concurrent spool uploads wait for the owner and keep independent checkpoints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-concurrent-'))
  const spool = path.join(root, 'spool')
  const day = path.join(spool, new Date().toISOString().slice(0, 10))
  fs.mkdirSync(day, { recursive: true })
  const checkpoint = path.join(root, 'checkpoint.json')
  // An unrelated newer spool scan must not suppress an older, unprocessed file.
  fs.writeFileSync(checkpoint, JSON.stringify({ __lastScanMtime: Date.now() + 10_000 }))
  const lock = path.join(root, '.uploader.lock')
  fs.writeFileSync(lock, String(process.pid))
  const received: string[] = []
  let inFlight = 0
  let peak = 0
  let rejectNext = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      received.push(JSON.parse(body).task_id)
      const reject = rejectNext
      rejectNext = false
      setTimeout(() => { inFlight--; if (reject) res.statusCode = 503; res.end('{"success":true}') }, 150)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as import('node:net').AddressInfo
  const children: ReturnType<typeof spawn>[] = []
  const jobs: Promise<{ code: number | null; stderr: string }>[] = []
  const startUpload = (file: string) => {
    const child = spawn(process.execPath, ['scripts/opencode_uploader_client.js'], {
        cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, AGENT_INSIGHT_HOME: root,
          AGENT_INSIGHT_HOST: 'http://127.0.0.1:' + address.port,
          AGENT_INSIGHT_API_KEY: '', AGENT_INSIGHT_UPLOADER_NO_MAIN: '0',
          HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*',
          AGENT_INSIGHT_OPENCODE_SPOOL_DIR: spool, AGENT_INSIGHT_OPENCODE_CHECKPOINT: checkpoint,
          AGENT_INSIGHT_UPLOADER_SPOOL_FILE: file, AGENT_INSIGHT_UPLOADER_FORCE: '0',
          AGENT_INSIGHT_UPLOADER_FORCE_SESSION: '', AGENT_INSIGHT_OPENCODE_UPLOAD_SINCE_MS: '0' },
      })
      children.push(child)
      jobs.push(new Promise((resolve, reject) => {
        let stderr = ''
        child.stderr!.on('data', data => { stderr += data })
        child.once('error', reject)
        child.once('close', code => resolve({ code, stderr }))
      }))
    return jobs[jobs.length - 1]
  }
  try {
    for (const suffix of ['first', 'second']) {
      const sid = 'ses_concurrent_' + suffix
      const records = [
        { kind: 'event', sessionID: sid, payload: { type: 'message.updated', event: { properties: { info: {
          id: 'msg_' + suffix, sessionID: sid, role: 'assistant', time: { created: 1, completed: 2 },
        } } } } },
        { kind: 'event', sessionID: sid, payload: { type: 'message.part.updated', event: { properties: { part: {
          id: 'prt_' + suffix, messageID: 'msg_' + suffix, sessionID: sid,
          type: 'text', text: 'business response', time: { start: 1, end: 2 },
        } } } } },
        { t: new Date().toISOString(), kind: 'event', sessionID: sid,
          payload: { type: 'session.idle', event: { properties: { sessionID: sid } } } },
      ]
      const file = path.join(day, suffix + '.jsonl')
      fs.writeFileSync(file, records.map(row => JSON.stringify(row)).join('\n') + '\n')
      startUpload(file)
    }
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.deepEqual(received, [], 'uploads must wait while an existing owner is alive')
    fs.unlinkSync(lock)
    const results = await Promise.all(jobs)
    for (const result of results) assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(received.sort(), ['ses_concurrent_first', 'ses_concurrent_second'], fs.readFileSync(path.join(root, 'logs', 'opencode_uploader.log'), 'utf8'))
    assert.equal(peak, 1, 'one uploader owns the shared checkpoint at a time')
    const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'))
    assert.ok(saved.ses_concurrent_first)
    assert.ok(saved.ses_concurrent_second)
    const firstFile = path.join(day, 'first.jsonl')
    const acknowledged = saved.__fileScanMtimes[firstFile]
    const previous = fs.readFileSync(firstFile, 'utf8')
    fs.writeFileSync(firstFile, previous.replace('business response', 'new business response'))
    fs.utimesSync(firstFile, new Date(), new Date(Date.now() + 1000))
    rejectNext = true
    await startUpload(firstFile)
    const failed = JSON.parse(fs.readFileSync(checkpoint, 'utf8'))
    assert.equal(failed.__fileScanMtimes[firstFile], acknowledged, 'a failed HTTP upload must remain pending')
    // A dead owner from a killed uploader must not block the next retry.
    fs.writeFileSync(lock, '2147483647')
    await startUpload(firstFile)
    const recovered = JSON.parse(fs.readFileSync(checkpoint, 'utf8'))
    assert.notEqual(recovered.ses_concurrent_first, saved.ses_concurrent_first)
    assert.ok(recovered.__fileScanMtimes[firstFile] > acknowledged)
    assert.equal(received.filter(sid => sid === 'ses_concurrent_first').length, 3)
  } finally {
    for (const child of children) if (child.exitCode == null) child.kill()
    await Promise.allSettled(jobs)
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
