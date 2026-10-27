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


const { execSync } = require('child_process')
const {
  findPidOnPort,
  killProcess,
  getPort,
  isPortListening
} = require('./utils.js')

const isWindows = process.platform === 'win32'

function killProcessByName(pattern) {
  if (isWindows) {
    try {
      execSync(`powershell -Command "Get-Process | Where-Object { $_.CommandLine -like '*${pattern}*' } | Stop-Process -Force"`, { stdio: 'ignore' })
      return true
    } catch (e) {
      return false
    }
  } else {
    try {
      execSync(`pkill -f "${pattern}"`, { stdio: 'ignore' })
      return true
    } catch (e) {
      return false
    }
  }
}

async function run(options) {
  const port = getPort(options)
  
  console.log(`=== Stopping Skill-Insight Service (Port: ${port}) ===\n`)
  
  const pid = findPidOnPort(port)
  
  if (pid) {
    console.log(`Found service running with PID: ${pid}`)
    
    if (killProcess(pid)) {
      console.log('✓ Service stopped successfully')
    } else {
      console.error(`❌ Failed to stop service (PID: ${pid})`)
      console.error('You may need to manually kill the process:')
      if (isWindows) {
        console.error(`  taskkill /F /PID ${pid}`)
      } else {
        console.error(`  kill -9 ${pid}`)
      }
      process.exit(1)
    }
    return
  }
  
  const isListening = await isPortListening(port)
  if (isListening) {
    console.log(`Service is running on port ${port} but PID not available.`)
    console.log('Trying to stop via process name...')
    
    killProcessByName('next dev')
    killProcessByName('next start')
    
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    const stillListening = await isPortListening(port)
    if (!stillListening) {
      console.log('✓ Service stopped successfully')
      return
    }
    
    console.error('❌ Failed to stop service automatically.')
    console.error('Please stop the service manually:')
    if (isWindows) {
      console.error('  taskkill /F /IM node.exe')
      console.error('  or use Task Manager to find and end the process')
    } else {
      console.error(`  pkill -f "next dev"`)
      console.error(`  pkill -f "next start"`)
      console.error('  or find the process and kill it:')
      console.error(`  ps aux | grep next`)
    }
    process.exit(1)
    return
  }
  
  console.log(`✓ No service running on port ${port}`)
}

module.exports = { run }
