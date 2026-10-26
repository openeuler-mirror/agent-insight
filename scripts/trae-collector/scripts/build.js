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

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

async function run(cmd) {
  console.log(`> ${cmd}`)
  return new Promise((resolve, reject) => {
    const [command, ...args] = cmd.split(' ')
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true,
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command failed with exit code ${code}`))
    })
    child.on('error', reject)
  })
}

async function build() {
  try {
    // Bundle with esbuild (replaces tsc — Trae IDE requires a single bundled file)
    console.log('🔧 Bundling with esbuild...')
    await run('npx esbuild src/extension.ts ' +
      '--bundle ' +
      '--platform=node ' +
      '--target=node16 ' +
      '--format=cjs ' +
      '--outfile=dist/extension.js ' +
      '--external:vscode ' +
      '--external:fs ' +
      '--external:path ' +
      '--external:os ' +
      '--external:child_process ' +
      '--sourcemap')

    // Package VSIX
    console.log('\n📦 Packaging VSIX...')
    await run('npx vsce package --no-dependencies')
    console.log('\n✅ VSIX package created!')

    const vsixFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.vsix'))
    for (const f of vsixFiles) {
      console.log(`   ${path.join(ROOT, f)}`)
    }
  } catch (err) {
    console.error('\n❌ Build failed:', err.message)
    if (err.message.includes('vsce')) {
      console.error('   Try: npm install -g @vscode/vsce')
    }
    if (err.message.includes('esbuild')) {
      console.error('   Try: npm install esbuild')
    }
    process.exit(1)
  }
}

build()
