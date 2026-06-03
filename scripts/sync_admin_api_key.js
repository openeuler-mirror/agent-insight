#!/usr/bin/env node

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

function updateEnvFile(envPath, updates) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const lines = existing ? existing.split(/\r?\n/) : []
  const pending = new Map(Object.entries(updates).filter(([, value]) => value !== undefined && value !== null))
  const seen = new Set()
  const output = []

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (!match) {
      output.push(line)
      continue
    }

    const key = match[1]
    if (!pending.has(key)) {
      output.push(line)
      continue
    }

    if (seen.has(key)) {
      continue
    }

    output.push(`${key}=${pending.get(key)}`)
    seen.add(key)
  }

  for (const [key, value] of pending) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`)
    }
  }

  while (output.length > 1 && output[output.length - 1] === '' && output[output.length - 2] === '') {
    output.pop()
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, output.join('\n').replace(/\n?$/, '\n'), 'utf8')
}

function requestAdminApiKey(port, host = 'localhost') {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ username: 'admin' })
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/api/auth/apikey',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            reject(new Error(`admin API key request returned ${res.statusCode}: ${data}`))
            return
          }

          try {
            const result = JSON.parse(data)
            if (!result.apiKey) {
              reject(new Error('admin API key response did not include apiKey'))
              return
            }
            resolve(result)
          } catch (error) {
            reject(new Error(`failed to parse admin API key response: ${error.message}`))
          }
        })
      },
    )

    req.on('error', reject)
    req.write(postData)
    req.end()
  })
}

async function syncAdminApiKey(options = {}) {
  const dataRoot = options.dataRoot || process.env.AGENT_INSIGHT_DATA_DIR || path.join(os.homedir(), '.agent-insight')
  const port = Number(options.port || process.env.PORT || 3000)
  const host = options.host || `http://localhost:${port}`
  const envPath = path.join(dataRoot, '.env')
  const keyFilePath = path.join(dataRoot, '.admin_api_key')

  const result = await requestAdminApiKey(port)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(keyFilePath, result.apiKey, 'utf8')
  updateEnvFile(envPath, {
    AGENT_INSIGHT_HOST: host,
    AGENT_INSIGHT_API_KEY: result.apiKey,
  })

  return {
    apiKey: result.apiKey,
    username: result.username,
    envPath,
    keyFilePath,
  }
}

async function main() {
  const port = Number(process.argv[2] || process.env.PORT || 3000)
  const host = process.argv[3] || `http://localhost:${port}`
  const result = await syncAdminApiKey({ port, host })
  console.log(`✓ Admin API key synced for ${result.username || 'admin'}`)
  console.log(`  API Key saved to: ${result.keyFilePath}`)
  console.log(`  Client env updated: ${result.envPath}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`⚠️  Failed to sync admin API key: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  updateEnvFile,
  requestAdminApiKey,
  syncAdminApiKey,
}
