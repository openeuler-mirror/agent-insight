const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadProjectConfig } = require('../../packages/project-config/index.cjs')

function describeFailure(detail) {
  if (/哈希.*(不匹配|失败)/.test(detail)) {
    return ['文件哈希校验失败', '请检查文件是否为要求的官方版本，具体查看相关部署指南。']
  }
  if (/本机文件不存在或不是普通文件/.test(detail)) {
    return ['本机来源文件不可用', '请检查 config/benchmark/platform.local.yaml 中 dataset.source 和 loader.sourceArchive 指定的文件，具体查看相关部署指南。']
  }
  if (/curl 执行失败/.test(detail)) {
    const sourceKey = /下载SWE-bench 官方源码/.test(detail)
      ? 'loader.sourceArchive'
      : 'dataset.source'
    const reason = /curl: \(28\)|timed? ?out|timeout/i.test(detail) ? '下载超时' : '下载失败'
    return [reason, `网络受限时，可在 config/benchmark/platform.local.yaml 中设置 benchmarks.swe-bench.${sourceKey} 为内网地址或本机文件路径，具体查看相关部署指南。`]
  }
  if (/缺少 python3-venv|无法创建 Python|loader.python 无法加载|Python 环境安装完成后仍无法加载|需要可执行命令：python3|(?:python3?|python\.exe|pip) 执行失败/.test(detail)) {
    return ['Python 环境准备或加载失败', '请安装所需 Python 依赖，或在 config/benchmark/platform.local.yaml 中用 benchmarks.swe-bench.loader.python 指定已有环境，具体查看相关部署指南。']
  }
  return ['自动准备或数据库导入失败', '请查看日志中的具体错误和相关部署指南。']
}

function main() {
  const managedHome = process.env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight')
  const logPath = path.join(managedHome, 'logs', 'swe-bench-bootstrap.log')
  let logFd
  let logReady = false
  let checkingConfig = true
  try {
    const config = loadProjectConfig('platform')
    checkingConfig = false
    if (!config.benchmarks['swe-bench'].dataset.autoImport) {
      console.log('SWE-bench Verified 自动导入已关闭，跳过准备。')
      return
    }
    console.log('Preparing SWE-bench Verified dataset...')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    logFd = fs.openSync(logPath, 'w', 0o600)
    logReady = true
    const result = spawnSync('npx', ['tsx', 'scripts/benchmark/ensure-swe-bench-dataset.ts'], {
      cwd: path.resolve(__dirname, '../..'),
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    })
    if (result.error) fs.writeSync(logFd, `${result.error.stack || result.error.message}\n`)
    if (result.signal) fs.writeSync(logFd, `导入进程被信号 ${result.signal} 终止\n`)
    if (result.status === 0) {
      console.log('SWE-bench Verified 数据集已就绪。')
      return
    }
    const [reason, advice] = describeFailure(fs.readFileSync(logPath, 'utf8'))
    console.warn(`⚠ SWE-bench Verified 导入失败：${reason}。`)
    console.warn('  将继续启动服务；SWE-bench Verified 相关实验暂不可用。')
    console.warn(`  ${advice}`)
    console.warn(`  详细错误见：${logPath}；下次启动自动重试。`)
  } catch (error) {
    console.warn(checkingConfig ? '⚠ SWE-bench Verified 导入配置无效。' : '⚠ SWE-bench Verified 自动准备或日志写入失败。')
    console.warn('  将继续启动服务；SWE-bench Verified 相关实验暂不可用。')
    console.warn(`  ${String(error.message || error).replace(/\s+/g, ' ').slice(0, 240)}`)
    console.warn(logReady
      ? `  详细错误见：${logPath}；下次启动自动重试。`
      : checkingConfig
        ? '  请修复配置文件，具体查看相关部署指南；下次启动自动重试。'
        : '  请检查日志目录的写入权限；下次启动自动重试。')
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd)
  }
}

main()
