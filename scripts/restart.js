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


const { sleep } = require('./utils.js')

async function run(options) {
  console.log('=== Restarting Skill-Insight Service ===\n')
  
  try {
    const stop = require('./stop.js')
    const start = require('./start.js')
    
    await stop.run(options)
    console.log()
    
    console.log('Waiting for port to release...')
    await sleep(2000)
    console.log()
    
    await start.run(options)
  } catch (error) {
    console.error('❌ Restart failed:', error.message)
    process.exit(1)
  }
}

module.exports = { run }
