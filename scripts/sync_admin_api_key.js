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

function readEnvValue(envPath, targetKey) {
  if (!fs.existsSync(envPath)) return ''
  const content = fs.readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || match[1] !== targetKey) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value
  }
  return ''
}

function requestAdminApiKey(port, host = 'localhost', timeoutMs = 5000) {
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

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`admin API key request timed out after ${timeoutMs}ms`))
    })
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
  // keyless 共享账号模式会清空客户端 key，让上报归到显式默认账号。
  // 普通模式仅在 key 缺失时用 admin 初始化；安装指导写入的邮箱用户 key 必须保留。
  const defaultIngestUser = (process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER || '').trim()
  if (defaultIngestUser) {
    updateEnvFile(envPath, {
      AGENT_INSIGHT_HOST: host,
      AGENT_INSIGHT_API_KEY: '',
    })
    return { apiKey: '', username: null, envPath, keyFilePath, skipped: true, defaultIngestUser }
  }

  const existingClientApiKey = readEnvValue(envPath, 'AGENT_INSIGHT_API_KEY')
  const requestApiKey = options.requestApiKey || requestAdminApiKey
  const requestTimeoutMs = Number(options.requestTimeoutMs || process.env.AGENT_INSIGHT_STARTUP_REQUEST_TIMEOUT_MS || 5000)
  const result = await requestApiKey(port, 'localhost', requestTimeoutMs)
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(keyFilePath, result.apiKey, 'utf8')
  const envUpdates = {
    AGENT_INSIGHT_HOST: host,
  }
  if (!existingClientApiKey) {
    envUpdates.AGENT_INSIGHT_API_KEY = result.apiKey
  }
  updateEnvFile(envPath, envUpdates)
  return {
    apiKey: result.apiKey,
    clientApiKey: existingClientApiKey || result.apiKey,
    preservedClientApiKey: Boolean(existingClientApiKey),
    username: result.username,
    envPath,
    keyFilePath,
  }
}

async function main() {
  const port = Number(process.argv[2] || process.env.PORT || 3000)
  const host = process.argv[3] || `http://localhost:${port}`
  const result = await syncAdminApiKey({ port, host })
  if (result.skipped) {
    console.log(`✓ keyless 模式：检测到 AGENT_INSIGHT_DEFAULT_INGEST_USER=${result.defaultIngestUser}`)
    console.log(`  已清空 ${result.envPath} 的 AGENT_INSIGHT_API_KEY（本机客户端以无 key 上报，归到默认账号），未同步 admin key`)
    return
  }
  console.log(`✓ Admin API key synced for ${result.username || 'admin'}`)
  console.log(`  API Key saved to: ${result.keyFilePath}`)
  if (result.preservedClientApiKey) {
    console.log(`  Client API key preserved: ${result.envPath}`)
  } else {
    console.log(`  Client env initialized: ${result.envPath}`)
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`⚠️  Failed to sync admin API key: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  updateEnvFile,
  readEnvValue,
  requestAdminApiKey,
  syncAdminApiKey,
}
