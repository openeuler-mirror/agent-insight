#!/usr/bin/env node

const {
  findPidOnPort,
  getPort,
  isPortListening
} = require('./utils.js')

async function run(options) {
  try {
    const port = getPort(options)
    
    console.log(`=== Skill-Insight Service Status ===\n`)
    
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
        console.log(`\nTo start: npx @witty-ai/skill-insight start --port ${port}`)
      }
    }
  } catch (error) {
    console.error('Error checking service status:', error.message)
    process.exit(1)
  }
}

module.exports = { run }
