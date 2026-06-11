#!/usr/bin/env node

const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')

const { sleep, isPortListening, findAvailablePort } = require('./utils.js')

function getPreferredHomeDataRoot() {
  return path.join(os.homedir(), '.agent-insight')
}

function getLegacyHomeDataRoot() {
  return path.join(os.homedir(), '.skill-insight')
}

async function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(' ')
    const proc = spawn(cmd, args, {
      stdio: options.silent ? 'pipe' : 'inherit',
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

    proc.on('error', (err) => {
      reject(err)
    })
  })
}

async function waitForService(port, maxRetries = 30, retryDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    const isReady = await isPortListening(port)
    if (isReady) {
      return true
    }
    process.stdout.write(`\r⏳ 等待服务启动... (${i + 1}/${maxRetries})`)
    await sleep(retryDelay)
  }
  return false
}

async function getApiKey(port) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ username: 'admin' })

    const options = {
      hostname: 'localhost',
      port: port,
      path: '/api/auth/apikey',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            const result = JSON.parse(data)
            if (result.apiKey) {
              resolve(result.apiKey)
            } else {
              reject(new Error('No apiKey in response'))
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`))
          }
        } else {
          reject(new Error(`Request failed with status ${res.statusCode}`))
        }
      })
    })

    req.on('error', (e) => {
      reject(e)
    })

    req.write(postData)
    req.end()
  })
}

async function callAutoSetup(port, apiKey) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32'
    const options = {
      hostname: 'localhost',
      port: port,
      path: `/api/setup/auto?apiKey=${encodeURIComponent(apiKey)}&host=localhost:${port}`,
      method: 'GET',
      headers: {
        'x-platform': isWindows ? 'windows' : 'unix'
      }
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data)
        } else {
          reject(new Error(`Auto setup failed with status ${res.statusCode}: ${data}`))
        }
      })
    })

    req.on('error', (e) => {
      reject(e)
    })

    req.end()
  })
}

async function run(options = {}) {
  const nodeVersion = process.version.replace(/^v/, '')
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10)
  if (isNaN(nodeMajor) || nodeMajor < 20) {
    console.log('\n')
    console.log('❌ Error: Node.js version ' + nodeVersion + ' is not supported.')
    console.log('   Agent-insight requires Node.js 20 or higher.')
    console.log('   Please upgrade your Node.js version: https://nodejs.org/')
    console.log('\n')
    process.exit(1)
  }

  let port = options.port || 3000
  const errors = []

  console.log('\n')
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║                                                            ║')
  console.log('║             🚀 Agent-insight 一键部署 🚀                ║')
  console.log('║                                                            ║')
  console.log('╚════════════════════════════════════════════════════════════╝')
  console.log('')

  console.log('📦 【步骤 1/5】安装 npm 包...')

  try {
    const oldDbPath = path.join(process.cwd(), 'node_modules', '@witty-ai', 'skill-insight', 'data', 'witty_insight.db')
    const newDbDir = path.join(getPreferredHomeDataRoot(), 'data')
    const newDbPath = path.join(newDbDir, 'witty_insight.db')
    const legacyDbPath = path.join(getLegacyHomeDataRoot(), 'data', 'witty_insight.db')

    if (!fs.existsSync(newDbPath) && (fs.existsSync(oldDbPath) || fs.existsSync(legacyDbPath))) {
      console.log('   ⚠️ 检测到旧版数据，正在迁移到 ~/.agent-insight/data ...')
      if (!fs.existsSync(newDbDir)) fs.mkdirSync(newDbDir, { recursive: true })
      fs.copyFileSync(fs.existsSync(legacyDbPath) ? legacyDbPath : oldDbPath, newDbPath)
      console.log('   ✅ 旧版数据已成功迁移至安全目录')
    }
  } catch (e) {
    console.log('   ⚠️ 数据迁移检测失败，跳过: ' + e.message)
  }

  // 把 npm 钉死在当前目录：当前目录没有 package.json 时，npm 会向上找最近的
  // 祖先项目（常见是被旧安装污染过的 $HOME），转而在那棵树上做安装——旧依赖的
  // postinstall 一挂，整个一键安装就死了，且当前目录什么都不会留下。
  if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
    fs.writeFileSync(
      path.join(process.cwd(), 'package.json'),
      JSON.stringify({ name: 'agent-insight-deploy', version: '1.0.0', private: true }, null, 2) + '\n'
    )
    console.log('   📄 当前目录无 package.json，已生成最小清单，安装将固定在本目录')
  }

  try {
    await runCommand('npm install agent-insight', { silent: true })
    console.log('   ✅ npm 包安装成功\n')
  } catch (error) {
    errors.push({ step: 1, message: `npm install 失败: ${error.message}` })
    console.log(`   ❌ npm 包安装失败: ${error.message}\n`)
  }

  const availablePort = findAvailablePort(port)
  if (availablePort !== port) {
    console.log(`🔄 端口 ${port} 已被占用，自动切换到端口 ${availablePort}\n`)
    port = availablePort
  }

  console.log('🔧 【步骤 2/5】启动服务...')
  try {
    const logPath = path.join(getPreferredHomeDataRoot(), 'install.log')
    const logDir = path.dirname(logPath)
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }

    const startProc = spawn('npx', ['agent-insight', 'start', '--port', port.toString()], {
      stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
      shell: true,
      detached: true
    })
    startProc.unref()
    console.log('   ✅ 服务启动命令已执行\n')
  } catch (error) {
    errors.push({ step: 2, message: `启动服务失败: ${error.message}` })
    console.log(`   ❌ 启动服务失败: ${error.message}\n`)
  }

  console.log('🔑 【步骤 3/5】等待服务就绪并获取 API Key...')
  let apiKey = null
  try {
    const isReady = await waitForService(port)
    console.log('')
    if (!isReady) {
      throw new Error(`服务在端口 ${port} 未就绪`)
    }
    console.log('   ✅ 服务已就绪')

    apiKey = await getApiKey(port)
    console.log('   ✅ 获取到 API Key\n')
  } catch (error) {
    errors.push({ step: 3, message: `获取 API Key 失败: ${error.message}` })
    console.log(`\n   ❌ 获取 API Key 失败: ${error.message}\n`)
  }

  console.log('🔌 【步骤 4/5】安装插件组件...')
  try {
    if (!apiKey) {
      throw new Error('没有可用的 API Key，跳过自动配置')
    }

    const scriptContent = await callAutoSetup(port, apiKey)
    const isWindows = process.platform === 'win32'
    const scriptDir = getPreferredHomeDataRoot()

    fs.mkdirSync(scriptDir, { recursive: true })

    let scriptPath, executeCommand
    if (isWindows) {
      scriptPath = path.join(scriptDir, 'auto_setup.ps1')
      fs.writeFileSync(scriptPath, scriptContent)
      console.log('   ✅ 配置脚本已下载 (PowerShell)')
      console.log('   📋 请选择要安装的框架...')
      executeCommand = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`
    } else {
      scriptPath = path.join(scriptDir, 'auto_setup.sh')
      fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 })
      console.log('   ✅ 配置脚本已下载 (Shell)')
      console.log('   📋 请选择要安装的框架...')
      executeCommand = `bash "${scriptPath}"`
    }

    await runCommand(executeCommand)

    console.log('\n   ✅ 插件安装完成\n')
  } catch (error) {
    errors.push({ step: 4, message: `插件安装失败: ${error.message}` })
    console.log(`   ❌ 插件安装失败: ${error.message}\n`)
  }

  console.log('📚 【步骤 5/5】添加技能...')
  try {
    await runCommand('npx skills add https://atomgit.com/openeuler/witty-skill-insight.git')
    console.log('\n   ✅ 技能添加成功\n')
  } catch (error) {
    errors.push({ step: 5, message: `添加技能失败: ${error.message}` })
    console.log(`   ❌ 添加技能失败: ${error.message}\n`)
  }

  console.log('════════════════════════════════════════════════════════════')
  console.log('                    🎉 部署完成 🎉')
  console.log('════════════════════════════════════════════════════════════')

  if (errors.length > 0) {
    console.log('\n')
    console.log('⚠️  以下步骤执行失败:')
    errors.forEach((err, idx) => {
      console.log(`   [步骤 ${err.step}] ${err.message}`)
    })
    console.log('\n请检查上述错误并手动处理。')
  } else {
    console.log('\n')
    console.log('✅ 所有步骤执行成功!')
  }

  console.log('\n')
  console.log('┌─────────────────────────────────────────────────────────────┐')
  console.log('│                                                             │')
  console.log(`│        🌐 服务地址: http://localhost:${port}                 │`)
  console.log('│                                                             │')
  console.log('└─────────────────────────────────────────────────────────────┘')
  console.log('')
}

module.exports = { run }
