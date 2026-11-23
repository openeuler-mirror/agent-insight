#!/usr/bin/env node
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


const {
  findPidOnPort,
  getPort,
  isPortListening
} = require('./utils.js')

async function run(options) {
  try {
    const port = getPort(options)
    
    console.log(`=== Agent-Insight Service Status ===\n`)
    
    const pid = findPidOnPort(port)
    
    if (pid) {
      console.log('✓ Service is running')
      console.log(`  PID: ${pid}`)
      console.log(`  Port: ${port}`)
      console.log(`  URL: http://localhost:${port}`)
    } else {
      const isListening = await isPortListening(port)
      if (isListening) {
        console.log('✓ Service is running')
        console.log(`  Port: ${port}`)
        console.log(`  URL: http://localhost:${port}`)
        console.log(`  Note: PID not available (limited permissions)`)
      } else {
        console.log('✗ Service is not running')
        console.log(`  Port: ${port}`)
        console.log(`\nTo start: npx agent-insight start --port ${port}`)
      }
    }
  } catch (error) {
    console.error('Error checking service status:', error.message)
    process.exit(1)
  }
}

module.exports = { run }
