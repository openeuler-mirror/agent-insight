'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const BRIDGE_VERSION = 1
const BINARY = 'insight-xiaoo-credentials'

async function buildNativeCredentials(source, run) {
  const metadata = JSON.parse(await run('cargo', ['metadata', '--locked', '--format-version', '1'], source, false, 32 * 1024 * 1024))
  const native = metadata.packages.find(pkg => pkg.name === 'llm-client')
  if (!native || !native.source?.startsWith('git+https://gitcode.com/openeuler/xiaoO.git')) throw new Error('无法定位 xGovernor 锁定的 xiaoO 原生凭据依赖')
  const root = path.resolve(path.dirname(native.manifest_path), '../..')
  const provider = path.join(root, 'apps/shared/src/gateway/decrypted_api_keys.rs')
  await fs.access(provider)
  const directory = path.join(source, 'insight-native-credentials')
  await fs.mkdir(path.join(directory, 'src'), { recursive: true })
  const quote = value => JSON.stringify(value)
  await fs.writeFile(path.join(directory, 'Cargo.toml'), `[package]\nname = ${quote(BINARY)}\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nllm-client = { path = ${quote(path.dirname(native.manifest_path))} }\nvault = { path = ${quote(path.join(root, 'apps/vault'))} }\nanyhow = "1"\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\ntoml = "0.8"\naes-gcm = "0.10"\n`)
  const bridge = await fs.readFile(path.join(__dirname, 'native-credentials.rs'), 'utf8')
  await fs.writeFile(path.join(directory, 'src/main.rs'), bridge.replace('env!("INSIGHT_XIAOO_SECRET_PROVIDER")', quote(provider)))
  await fs.copyFile(path.join(source, 'Cargo.lock'), path.join(directory, 'Cargo.lock'))
  // 原生模块路径仅供编译期 include，凭据不参与构建或落盘。
  await run('cargo', ['build', '--release', '--manifest-path', path.join(directory, 'Cargo.toml')], source, true)
  const description = JSON.parse(await run(path.join(source, 'target/release', BINARY), ['--describe'], source, false))
  if (description.schemaVersion !== 1 || description.bridgeVersion !== BRIDGE_VERSION) throw new Error('xiaoO 原生凭据桥接协议不兼容')
  return { version: BRIDGE_VERSION, source: native.source }
}

module.exports = { buildNativeCredentials, BRIDGE_VERSION, BINARY }
