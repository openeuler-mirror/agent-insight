'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')
const { error } = require('./client.cjs')
const { BINARY } = require('./native-credentials-build.cjs')

const REASONS = {
  MODEL_CONFIG_UNREADABLE: ['MODEL_CONFIGURATION_INVALID', '无法读取原生 config.toml，请检查执行账号、配置路径和文件权限'],
  MODEL_CONFIG_INVALID: ['MODEL_CONFIGURATION_INVALID', '原生 config.toml 的模型配置不合法，请在 xiaoo 中检查配置'],
  MODEL_PROFILE_INVALID: ['MODEL_CONFIGURATION_INVALID', '实验所选模型与原生启用的模型配置不匹配，请检查 active_profile/provider/model'],
  MODEL_PROVIDER_UNSUPPORTED: ['MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE', '当前凭据桥接版本不支持所选 provider，请更新客户端；这不代表模型或 Key 无效'],
  MODEL_CREDENTIAL_STORE_UNREADABLE: ['MODEL_CREDENTIAL_STORE_UNREADABLE', '无法读取或解密原生凭据库 llm_secrets.json，请检查执行账号、文件权限及原生 Vault/SDF 环境；无需另配 xGovernor Key'],
  MODEL_CREDENTIAL_MISSING: ['MODEL_CREDENTIAL_MISSING', '原生凭据库及客户端运行环境均未提供所需的非空凭据，请在执行机器的原生 xiaoo 中配置后重跑 Case'],
  MODEL_CONFIGURATION_INVALID: ['MODEL_CONFIGURATION_INVALID', '原生模型配置无法解析，请检查配置后重跑 Case'],
}

function bridgeUnavailable() {
  return error('MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE', 'xiaoo 原生凭据桥接未就绪或版本不兼容，请重新执行客户端安装命令；这不代表模型或 Key 无效')
}

async function readNativeCredentials(configPath, modelId, runtime, env, spawnImpl = spawn) {
  const executable = runtime.credentialExecutable || (runtime.workerExecutable && path.join(path.dirname(runtime.workerExecutable), BINARY))
  if (!executable) throw bridgeUnavailable()
  const result = await new Promise((resolve, reject) => {
    const child = spawnImpl(executable, [], { env, stdio: ['pipe', 'ignore', 'ignore', 'pipe'] })
    let output = ''; let overflow = false
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 10000)
    child.stdin.on('error', () => {})
    child.stdio[3].on('data', data => {
      output += data
      if (output.length > 65536) { overflow = true; child.kill('SIGKILL') }
    })
    child.once('error', () => { clearTimeout(timer); reject(bridgeUnavailable()) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code || overflow) return reject(bridgeUnavailable())
      try {
        const value = JSON.parse(output)
        if (value.schemaVersion !== 1) throw new Error()
        resolve(value)
      } catch { reject(bridgeUnavailable()) }
    })
    child.stdin.end(JSON.stringify({ configPath, modelId }))
  })
  if (result.error) {
    const reason = REASONS[result.error]
    if (!reason) throw bridgeUnavailable()
    const variable = typeof result.environment === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(result.environment) ? `（凭据引用：${result.environment}）` : ''
    throw error(reason[0], `xiaoo：${reason[1]}${variable}。模型请求尚未发出。`)
  }
  if (!result.llm || typeof result.llm !== 'object' || Array.isArray(result.llm)) throw bridgeUnavailable()
  if (result.credentialRequired === false && result.credential == null) throw error('MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE', 'xiaoo 原生模型允许无 Key 访问，但当前 xGovernor 桥接要求非空凭据，暂不支持该认证方式；模型请求尚未发出')
  return result
}

module.exports = { readNativeCredentials }
