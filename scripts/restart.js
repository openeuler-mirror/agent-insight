#!/usr/bin/env node

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
