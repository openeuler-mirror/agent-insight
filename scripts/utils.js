const { execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')

function getDataRoot() {
  if (process.env.SKILL_INSIGHT_DATA_DIR) {
    return process.env.SKILL_INSIGHT_DATA_DIR
  }
  if (__dirname.includes('node_modules')) {
    return path.join(os.homedir(), '.skill-insight')
  }
  return path.resolve(__dirname, '..')
}

function migrateDataIfNeeded() {
  const newDataRoot = path.join(os.homedir(), '.skill-insight')
  const newDbPath = path.join(newDataRoot, 'data', 'witty_insight.db')
  const oldDbPath = path.resolve(__dirname, '../data/witty_insight.db')

  const newExists = fs.existsSync(newDbPath)
  const oldExists = fs.existsSync(oldDbPath)

  if (newExists && oldExists) {
    console.log('Database already exists at new location, skipping migration')
    return
  }

  if (newExists && !oldExists) {
    console.log('Using existing database at ' + newDbPath)
    return
  }

  if (!newExists && oldExists) {
    console.log('Migrating database to new location...')
    const newDataPath = path.join(newDataRoot, 'data')
    if (!fs.existsSync(newDataPath)) {
      fs.mkdirSync(newDataPath, { recursive: true })
    }
    fs.copyFileSync(oldDbPath, newDbPath)
    console.log('✓ Database migrated to ' + newDbPath)

    return
  }

  console.log('Creating new database at ' + newDbPath)
}

function findPidOnPort(port) {
  const platform = process.platform

  try {
    if (platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
      const lines = output.trim().split('\n')
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 5) {
          const localAddress = parts[1]
          const state = parts[3]
          const pid = parts[4]
          const portMatch = localAddress.match(/:(\d+)$/)
          if (portMatch && parseInt(portMatch[1]) === port && state === 'LISTENING') {
            console.log(`[Windows] Found process ${pid} listening on port ${port}`)
            return pid
          }
        }
      }
      console.log(`[Windows] No process found listening on port ${port}`)
    } else {
      if (fs.existsSync('/usr/bin/lsof') || fs.existsSync('/usr/sbin/lsof')) {
        try {
          const pid = execSync(`lsof -t -i:${port} -sTCP:LISTEN`, { encoding: 'utf8' })
          if (pid.trim()) return pid.trim()
        } catch (e) {}
      }

      if (fs.existsSync('/bin/ss') || fs.existsSync('/usr/bin/ss')) {
        try {
          const output = execSync(`ss -lptn "sport = :${port}"`, { encoding: 'utf8' })
          const match = output.match(/pid=(\d+)/)
          if (match) return match[1]
        } catch (e) {}
      }

      if (fs.existsSync('/bin/netstat') || fs.existsSync('/usr/bin/netstat')) {
        try {
          const output = execSync(`netstat -nlp 2>/dev/null | grep ":${port} "`, { encoding: 'utf8' })
          const match = output.match(/(\d+)\//)
          if (match) return match[1]
        } catch (e) {}
      }

      try {
        const output = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: 'utf8' })
        if (output.trim()) return output.trim()
      } catch (e) {}
    }
  } catch (e) {}

  return null
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: port,
      path: '/',
      method: 'HEAD',
      timeout: 1000
    }, (res) => {
      resolve(true)
    })

    req.on('error', () => {
      resolve(false)
    })

    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })

    req.end()
  })
}

function killProcess(pid) {
  const platform = process.platform

  try {
    if (platform === 'win32') {
      console.log(`[Windows] Attempting to kill process with PID ${pid} using taskkill...`)
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' })
      console.log(`[Windows] Successfully killed process ${pid}`)
      return true
    } else {
      console.log(`[Unix] Attempting to kill process with PID ${pid} using kill -9...`)
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
      console.log(`[Unix] Successfully killed process ${pid}`)
      return true
    }
  } catch (e) {
    console.error(`Failed to kill process ${pid}: ${e.message}`)
    return false
  }
}

function getPort(options) {
  if (options.port) return options.port
  if (process.env.PORT) return parseInt(process.env.PORT)

  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8')
    const match = envContent.match(/^PORT=(\d+)$/m)
    if (match) return parseInt(match[1])
  }

  return 3000
}

function ensureEnvFile(packageRoot) {
  const root = getDataRoot()
  const envPath = path.join(root, '.env')
  const envExamplePath = path.join(path.resolve(__dirname, '..'), '.env.example')

  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    console.log('No .env found. Initializing from .env.example...')
    fs.mkdirSync(path.dirname(envPath), { recursive: true })
    fs.copyFileSync(envExamplePath, envPath)
    console.log('✓ .env file created at ' + envPath)
  }
}

function ensureDataDirectory(packageRoot) {
  const root = getDataRoot()
  const dataPath = path.join(root, 'data')
  if (!fs.existsSync(dataPath)) {
    console.log('Creating data directory...')
    fs.mkdirSync(dataPath, { recursive: true })
    console.log('✓ data directory created at ' + dataPath)
  }
}

function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command}`)
    const [cmd, ...args] = command.split(' ')
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      shell: true,
      ...options
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Command failed with code ${code}`))
      }
    })
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function findAvailablePort(startPort = 3000, maxAttempts = 100) {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    const pid = findPidOnPort(port)
    if (!pid) {
      return port
    }
  }
  return startPort
}

module.exports = {
  findPidOnPort,
  killProcess,
  getPort,
  ensureEnvFile,
  ensureDataDirectory,
  runCommand,
  sleep,
  isPortListening,
  findAvailablePort,
  getDataRoot,
  migrateDataIfNeeded
}