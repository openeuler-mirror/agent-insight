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

'use strict'

const fs = require('node:fs')
const { spawn } = require('node:child_process')
const readline = require('node:readline')

function captureWorker(executable, snapshotPath, args = []) {
  const child = spawn(executable, args, { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] })
  process.stdin.pipe(child.stdin)
  child.stdin.on('error', () => {})
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
    try {
      const message = JSON.parse(line)
      if (message.kind === 'state') {
        const temporary = `${snapshotPath}.${process.pid}.tmp`
        const descriptor = fs.openSync(temporary, 'w', 0o600)
        try { fs.writeFileSync(descriptor, JSON.stringify(message.state)); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
        fs.renameSync(temporary, snapshotPath)
      }
    } catch (cause) {
      if (cause instanceof SyntaxError) { process.stdout.write(`${line}\n`); return }
      process.stderr.write('Cannot persist xGovernor worker state\n')
      child.kill('SIGTERM')
      process.exitCode = 1
      return
    }
    if (!process.stdout.write(`${line}\n`)) lines.pause()
  })
  process.stdout.on('drain', () => lines.resume())
  child.on('error', () => { process.stderr.write('Cannot start xGovernor worker\n'); process.exitCode = 1 })
  child.on('close', (code, signal) => {
    process.stdin.unpipe(child.stdin)
    process.stdin.pause()
    process.exitCode = process.exitCode || code || (signal ? 1 : 0)
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
}

if (require.main === module) captureWorker(process.argv[2], process.argv[3], process.argv.slice(4))
module.exports = { captureWorker }
