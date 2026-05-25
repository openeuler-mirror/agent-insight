#!/usr/bin/env node

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

async function run(options) {
  const logPath = path.join(process.cwd(), 'server.log')
  
  if (!fs.existsSync(logPath)) {
    console.log('No log file found. The service may not have been started yet.')
    return
  }
  
  console.log('=== Skill-Insight Service Logs ===\n')
  console.log('Press Ctrl+C to exit\n')
  
  const tail = spawn('tail', ['-f', logPath], { stdio: 'inherit' })
  
  tail.on('error', (error) => {
    console.error('Failed to tail tail log file:', error.message)
    console.log('\nYou can view the log file directly:')
    console.log(`  cat ${logPath}`)
    process.exit(1)
  })
  
  process.on('SIGINT', () => {
    tail.kill()
    process.exit(0)
  })
  
  process.on('SIGTERM', () => {
    tail.kill()
    process.exit(0)
  })
}

module.exports = { run }
