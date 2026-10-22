'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')

function toolchainEnvironment(root, env = process.env) {
  const base = path.join(root, 'toolchain')
  const result = { ...env, PATH: [path.join(base, 'node/bin'), path.join(base, 'cargo/bin'), env.PATH].filter(Boolean).join(path.delimiter), CARGO_BUILD_JOBS: '2' }
  if (fs.existsSync(path.join(base, 'cargo/bin/cargo'))) Object.assign(result, { CARGO_HOME: path.join(base, 'cargo'), RUSTUP_HOME: path.join(base, 'rustup') })
  return result
}
function nodeSupported(version) {
  const [major, minor] = String(version).trim().replace(/^v/, '').split('.').map(Number)
  return major > 22 || major === 22 && minor >= 19
}
async function ensureBuildTools({ root, env = process.env, target, command: run, log = console.log }) {
  const base = path.join(root, 'toolchain')
  await fsp.mkdir(base, { recursive: true, mode: 0o700 })
  let buildEnv = toolchainEnvironment(root, env)
  const available = async (file, args = ['--version']) => { try { return await run(file, args, { env: buildEnv, timeoutMs: 10000 }) } catch { return '' } }
  const required = ['git', 'cc', 'c++', 'make', 'pkg-config', 'curl', 'tar', 'xz', 'python3']
  const missing = []
  for (const tool of required) if (!await available(tool)) missing.push(tool)
  try { await run('pkg-config', ['--exists', 'openssl'], { env: buildEnv, timeoutMs: 10000 }) } catch { missing.push('OpenSSL headers') }
  let needsTomli = false
  try { await run('python3', ['-c', 'import importlib.util; assert importlib.util.find_spec("tomllib") or importlib.util.find_spec("tomli")'], { env: buildEnv, timeoutMs: 10000 }) } catch { needsTomli = true; missing.push('Python TOML parser') }
  if (missing.length) {
    const manager = await available('apt-get') ? 'apt-get' : await available('dnf') ? 'dnf' : await available('yum') ? 'yum' : null
    if (!manager) throw new Error(`缺少编译工具 ${missing.join(', ')}；此发行版需管理员安装`)
    const prefix = process.getuid?.() === 0 ? [] : ['sudo', '-n']
    const packages = manager === 'apt-get' ? ['git', 'build-essential', 'pkg-config', 'libssl-dev', 'curl', 'ca-certificates', 'xz-utils', 'python3'] : ['git', 'gcc', 'gcc-c++', 'make', 'pkgconf-pkg-config', 'openssl-devel', 'curl', 'ca-certificates', 'xz', 'python3']
    if (needsTomli) packages.push('python3-tomli')
    const install = async args => run(prefix[0] || manager, [...prefix.slice(1), ...(prefix.length ? [manager] : []), ...args], { env: { ...buildEnv, DEBIAN_FRONTEND: 'noninteractive' }, verbose: true })
    log(`[xgovernor] 安装缺失的系统编译依赖：${missing.join(', ')}`)
    if (manager === 'apt-get') await install(['update'])
    await install(['install', '-y', ...packages])
  }
  if (!nodeSupported(await available('node'))) {
    const name = `node-v22.19.0-linux-${target.arch}`
    const archive = `${name}.tar.xz`
    const download = path.join(base, archive)
    const url = 'https://nodejs.org/dist/v22.19.0'
    log('[xgovernor] 安装独立 Node 22.19.0，不替换系统 Node')
    await run('curl', ['-fSL', '--retry', '3', `${url}/${archive}`, '-o', download], { env: buildEnv })
    const sums = await run('curl', ['-fsSL', `${url}/SHASUMS256.txt`], { env: buildEnv })
    const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === archive)?.[0]
    const actual = createHash('sha256').update(await fsp.readFile(download)).digest('hex')
    if (!expected || expected !== actual) throw new Error('Node 下载校验失败')
    await run('tar', ['-xJf', download, '-C', base], { env: buildEnv })
    if (!fs.existsSync(path.join(base, 'node'))) await fsp.symlink(name, path.join(base, 'node'))
    buildEnv = toolchainEnvironment(root, env)
  }
  const cargoVersion = await available('cargo')
  const cargoParts = /cargo (\d+)\.(\d+)/.exec(cargoVersion)
  if (!cargoParts || Number(cargoParts[1]) < 1 || Number(cargoParts[1]) === 1 && Number(cargoParts[2]) < 97) {
    log('[xgovernor] 安装独立 Rust 工具链，不修改 shell 配置或 MCTS')
    const installer = path.join(base, 'rustup-init.sh')
    await run('curl', ['-fSL', '--retry', '3', 'https://sh.rustup.rs', '-o', installer], { env: buildEnv })
    await run('sh', [installer, '-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', '1.97.1'], {
      env: { ...buildEnv, CARGO_HOME: path.join(base, 'cargo'), RUSTUP_HOME: path.join(base, 'rustup') }, verbose: true,
    })
  }
}
module.exports = { toolchainEnvironment, ensureBuildTools, nodeSupported }
