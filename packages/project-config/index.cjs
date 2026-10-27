'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const yaml = require('./yaml.cjs')

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const nullableString = (value) => value === null || (typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value))
const leaf = (defaultValue, valid, normalize) => ({ defaultValue, valid, normalize })
const boolean = (defaultValue) => leaf(defaultValue, (value) => typeof value === 'boolean')
const integer = (defaultValue) => leaf(defaultValue, positiveInteger)
const choice = (defaultValue, values) => leaf(defaultValue, (value) => values.includes(value))

function resolvePath(value, filePath) {
  if (value === null) return null
  const expanded = value.trim().replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, os.homedir())
  return path.resolve(path.dirname(filePath), expanded)
}

function source(value, filePath) {
  if (value === null) return null
  value = value.trim()
  if (/^https?:\/\//i.test(value)) {
    new URL(value)
    return value.trim()
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error('必须是 HTTP(S) 地址或文件路径')
  return resolvePath(value, filePath)
}

function gitSource(value, filePath) {
  if (value === null) return null
  value = value.trim()
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) throw new Error('Git 根地址不能包含凭证、query 或 fragment')
    return value.trim()
  }
  return source(value, filePath)
}

function runtimeOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([key, runtime]) => {
    if (!/^[a-z][a-z0-9-]*$/.test(key) || !runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return false
    if (Object.keys(runtime).some(key => key !== 'defaults')) return false
    if (runtime.defaults === undefined) return true
    if (!runtime.defaults || typeof runtime.defaults !== 'object' || Array.isArray(runtime.defaults)) return false
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../agent-runtime/parameter-json.cjs').validateParameterObject(runtime.defaults)
      return true
    }
    catch { return false }
  })
}

const schemas = {
  platform: {
    benchmarks: {
      'swe-bench': {
        dataset: { autoImport: boolean(true), source: leaf(null, nullableString, source) },
        loader: { sourceArchive: leaf(null, nullableString, source), python: leaf(null, nullableString, resolvePath) },
      },
      'zsoft-l1': {
        dataset: {
          autoImport: boolean(true),
          source: leaf(null, nullableString, source),
          revision: leaf(null, value => value === null || (typeof value === 'string' && /^[a-f0-9]{40}$/.test(value))),
        },
      },
      scheduling: {
        maxPendingEvaluations: integer(256),
        maxPendingEvaluationsPerUser: integer(128),
        maxEvaluationConcurrencyPerUser: leaf(null, (value) => value === null || positiveInteger(value)),
      },
    },
  },
  evaluator: {
    maxConcurrency: integer(1),
    benchmarks: {
      'swe-bench': {
        python: leaf('python3', (value) => typeof value === 'string' && /^(?:[\w.-]+|\/[^\r\n]+)$/.test(value)),
        images: {
          source: choice('official', ['official', 'epoch']),
          arch: choice('auto', ['auto', 'x86_64', 'arm64']),
          allowNonOfficial: boolean(false),
          proxyPrefix: leaf(null, (value) => value === null || (typeof value === 'string' && /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*$/i.test(value))),
          verifiedMirrorRepositories: leaf(null, (value) => value === null || (Array.isArray(value) && value.length <= 8 && value.every((item) => typeof item === 'string' && /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/.test(item)))),
        },
        docker: { requestTimeoutSeconds: integer(1800), connectionPoolSize: integer(16) },
      },
      'zsoft-l1': {
        assetsDir: leaf(null, value => nullableString(value) && (value === null || !/^[a-z][a-z\d+.-]*:\/\//i.test(value)), resolvePath),
        kernelAccel: choice('tcg', ['tcg', 'kvm']),
      },
    },
    imagePool: {
      enabled: boolean(true),
      prefetchEnabled: boolean(true),
      reserveRatio: leaf(0.3, (value) => typeof value === 'number' && value > 0 && value < 1),
      highWatermark: leaf(0.9, (value) => typeof value === 'number' && value > 0 && value < 1),
      maxPulls: leaf(2, (value) => positiveInteger(value) && value <= 8),
      waitSeconds: leaf(600, (value) => typeof value === 'number' && value > 0 && value <= 86400),
      macDiskPath: leaf(null, nullableString, resolvePath),
    },
  },
  executor: {
    retention: { days: integer(7) },
    benchmarks: {
      'swe-bench': {
        gitSource: leaf(null, nullableString, gitSource),
        images: {
          source: choice('official', ['official', 'epoch']),
          arch: choice('auto', ['auto', 'x86_64', 'arm64']),
          allowNonOfficial: boolean(false),
          proxyPrefix: leaf(null, (value) => value === null || (typeof value === 'string' && /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*$/i.test(value))),
          verifiedMirrorRepositories: leaf(null, (value) => value === null || (Array.isArray(value) && value.length <= 8 && value.every((item) => typeof item === 'string' && /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/.test(item)))),
        },
      },
    },
    runtimes: leaf({}, runtimeOverrides),
    execution: leaf({}, value => value && typeof value === 'object' && !Array.isArray(value)),
  },
}

const legacySettings = {
  platform: {
    AGENT_INSIGHT_BENCHMARK: 'benchmarks.swe-bench.dataset.autoImport',
    SWE_BENCH_DATASET_SOURCE: 'benchmarks.swe-bench.dataset.source',
    SWE_BENCH_DATASET_PATH: 'benchmarks.swe-bench.dataset.source',
    SWE_BENCH_DATASET_URL: 'benchmarks.swe-bench.dataset.source',
    SWE_BENCH_SOURCE_ARCHIVE_SOURCE: 'benchmarks.swe-bench.loader.sourceArchive',
    SWE_BENCH_SOURCE_ARCHIVE_URL: 'benchmarks.swe-bench.loader.sourceArchive',
    SWE_BENCH_PYTHON: 'benchmarks.swe-bench.loader.python',
    ZSOFT_DATASET_SOURCE: 'benchmarks.zsoft-l1.dataset.source',
    ZSOFT_DATASET_REVISION: 'benchmarks.zsoft-l1.dataset.revision',
    AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS: 'benchmarks.scheduling.maxPendingEvaluations',
    AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER: 'benchmarks.scheduling.maxPendingEvaluationsPerUser',
    AGENT_INSIGHT_BENCHMARK_EVAL_MAX_CONCURRENCY_PER_USER: 'benchmarks.scheduling.maxEvaluationConcurrencyPerUser',
  },
  evaluator: {
    EVALUATOR_MAX_CONCURRENCY: 'maxConcurrency',
    ZSOFT_L1_ASSETS_DIR: 'benchmarks.zsoft-l1.assetsDir',
    ZSOFT_KERNEL_ACCEL: 'benchmarks.zsoft-l1.kernelAccel',
    SWE_BENCH_PYTHON: 'benchmarks.swe-bench.python',
    SWE_BENCH_IMAGE_SOURCE: 'benchmarks.swe-bench.images.source',
    SWE_BENCH_IMAGE_ARCH: 'benchmarks.swe-bench.images.arch',
    SWE_BENCH_ALLOW_NON_OFFICIAL: 'benchmarks.swe-bench.images.allowNonOfficial',
    SWE_BENCH_IMAGE_PROXY_PREFIX: 'benchmarks.swe-bench.images.proxyPrefix',
    SWE_BENCH_VERIFIED_MIRROR_REPOS: 'benchmarks.swe-bench.images.verifiedMirrorRepositories',
    SWEBENCH_DOCKER_TIMEOUT: 'benchmarks.swe-bench.docker.requestTimeoutSeconds',
    SWEBENCH_DOCKER_POOL_SIZE: 'benchmarks.swe-bench.docker.connectionPoolSize',
    IMAGE_POOL_ENABLED: 'imagePool.enabled',
    IMAGE_POOL_PREFETCH_ENABLED: 'imagePool.prefetchEnabled',
    IMAGE_POOL_RESERVE_RATIO: 'imagePool.reserveRatio',
    IMAGE_POOL_HIGH_WATERMARK: 'imagePool.highWatermark',
    IMAGE_POOL_MAX_PULLS: 'imagePool.maxPulls',
    IMAGE_POOL_WAIT_SECONDS: 'imagePool.waitSeconds',
    IMAGE_POOL_MAC_DISK_PATH: 'imagePool.macDiskPath',
  },
  executor: { SWE_BENCH_GIT_SOURCE: 'benchmarks.swe-bench.gitSource' },
}
const warned = new Set()

function parseEvaluatorEnv(assignments) {
  const overrides = {}
  const passthrough = []
  for (const assignment of assignments) {
    if (typeof assignment !== 'string' || /[\r\n\0]/.test(assignment) || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(assignment)) throw new Error('--evaluator-env 必须是单行 NAME=VALUE')
    const separator = assignment.indexOf('=')
    const name = assignment.slice(0, separator)
    const raw = assignment.slice(separator + 1)
    const field = Object.hasOwn(legacySettings.evaluator, name) ? legacySettings.evaluator[name] : null
    if (!field) {
      if (/^(SWE_BENCH_|SWEBENCH_|IMAGE_POOL_)/.test(name)) throw new Error(`--evaluator-env 不支持的配置变量：${name}`)
      passthrough.push(assignment)
      continue
    }
    const keys = field.split('.')
    const rule = keys.reduce((schema, key) => schema[key], schemas.evaluator)
    let value = raw.trim()
    try {
      if (typeof rule.defaultValue === 'boolean') {
        if (!/^(true|false|1|0)$/i.test(value)) throw new Error()
        value = /^(true|1)$/i.test(value)
      } else if (typeof rule.defaultValue === 'number') {
        if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error()
        value = Number(value)
      } else if (name === 'SWE_BENCH_VERIFIED_MIRROR_REPOS') {
        value = value === 'null' ? null : value.startsWith('[') ? JSON.parse(value) : value ? value.split(',').map(item => item.trim()) : []
      } else if (rule.defaultValue === null && !value) value = null
      if (!rule.valid(value)) throw new Error()
    } catch { throw new Error(`--evaluator-env ${name} 的类型或取值不合法（配置字段 ${field}）`) }
    let target = overrides
    for (const key of keys.slice(0, -1)) target = target[key] ||= {}
    target[keys.at(-1)] = value
  }
  return { overrides, passthrough }
}

function warnLegacy(scope, env = process.env, warn = console.warn) {
  for (const [name, field] of Object.entries(legacySettings[scope])) {
    const key = `${scope}:${name}`
    if (env[name] !== undefined && !warned.has(key)) {
      warned.add(key)
      warn(`⚠ ${name} 已迁移至 config/benchmark/${scope}.local.yaml 的 ${field}，不再生效。`)
    }
  }
}

function defaults(schema) {
  if ('defaultValue' in schema) return structuredClone(schema.defaultValue)
  return Object.fromEntries(Object.entries(schema).map(([key, item]) => [key, defaults(item)]))
}

function apply(target, schema, values, filePath, prefix = '') {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`${filePath}: ${prefix || '根节点'} 必须是配置对象`)
  for (const [key, value] of Object.entries(values)) {
    const field = prefix ? `${prefix}.${key}` : key
    if (!Object.hasOwn(schema, key)) throw new Error(`${filePath}: 未知配置字段 ${field}`)
    const rule = schema[key]
    if ('defaultValue' in rule) {
      try {
        if (!rule.valid(value)) throw new Error('类型或取值不合法')
        if (field === 'runtimes') {
          for (const [runtimeKey, runtime] of Object.entries(value)) {
            target[key][runtimeKey] = { defaults: { ...target[key][runtimeKey]?.defaults, ...structuredClone(runtime.defaults || {}) } }
          }
        } else if (field === 'execution') {
          const merge = (base, next) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(next)])].map(key => [key,
            next[key] === undefined ? base[key]
              : base[key] && next[key] && typeof base[key] === 'object' && typeof next[key] === 'object' && !Array.isArray(base[key]) && !Array.isArray(next[key])
                ? merge(base[key], next[key]) : structuredClone(next[key]),
          ]))
          target[key] = merge(target[key], value)
        } else target[key] = rule.normalize ? rule.normalize(value, filePath) : structuredClone(value)
      } catch (error) {
        throw new Error(`${filePath}: ${field} ${error.message}`)
      }
    } else apply(target[key], rule, value, filePath, field)
  }
}

function loadProjectConfig(scope, options = {}) {
  if (!Object.hasOwn(schemas, scope)) throw new Error(`未知配置范围：${scope}`)
  const env = options.env || process.env
  warnLegacy(scope, env, options.warn || console.warn)
  const config = defaults(schemas[scope])
  if (scope === 'evaluator' && env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON) {
    apply(config, schemas[scope], JSON.parse(env.AGENT_INSIGHT_EVALUATOR_CONFIG_JSON), 'Evaluator 配置快照')
  } else {
    const root = options.root || env.AGENT_INSIGHT_PACKAGE_ROOT || path.resolve(__dirname, '../..')
    const configuredDir = options.configDir || env.AGENT_INSIGHT_CONFIG_DIR
    const directory = configuredDir ? path.resolve(root, configuredDir) : path.join(root, 'config', 'benchmark')
    const installedExecutor = scope === 'executor' && !configuredDir && fs.existsSync(path.join(root, 'reliability-client.cjs'))
    const localDirectory = installedExecutor
      ? path.join(require(path.join(root, 'agent-insight-home.cjs')).getAgentInsightHome(env), 'config')
      : directory
    for (const filePath of [path.join(directory, `${scope}.yaml`), path.join(localDirectory, `${scope}.local.yaml`)]) {
      let text
      try { text = fs.readFileSync(filePath, 'utf8') }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      let values
      try { values = yaml.load(text, { schema: yaml.JSON_SCHEMA }) }
      catch (error) { throw new Error(`${filePath}: ${error.message}`) }
      const originPath = options.pathBaseDir ? path.join(options.pathBaseDir, path.basename(filePath)) : filePath
      apply(config, schemas[scope], values === undefined ? {} : values, originPath)
    }
  }
  if (options.deploymentOverrides) {
    if (scope !== 'evaluator') throw new Error('显式部署覆盖仅适用于 evaluator 配置')
    const directory = options.pathBaseDir || options.configDir || env.AGENT_INSIGHT_CONFIG_DIR || path.join(options.root || env.AGENT_INSIGHT_PACKAGE_ROOT || path.resolve(__dirname, '../..'), 'config', 'benchmark')
    apply(config, schemas.evaluator, options.deploymentOverrides, path.join(directory, '--evaluator-env'))
  }
  if (scope === 'evaluator') {
    const images = config.benchmarks['swe-bench'].images
    if (images.source === 'epoch' && (!images.allowNonOfficial || images.arch === 'x86_64')) {
      throw new Error('config/benchmark/evaluator.yaml: benchmarks.swe-bench.images.source=epoch 需要允许非官方镜像且使用 ARM64')
    }
    if (config.imagePool.enabled && config.imagePool.prefetchEnabled && config.imagePool.maxPulls < 2) {
      throw new Error('config/benchmark/evaluator.yaml: imagePool.maxPulls 开启预取时至少为 2')
    }
  }
  if (scope === 'executor') {
    const images = config.benchmarks['swe-bench'].images
    if (images.source === 'epoch' && (!images.allowNonOfficial || images.arch === 'x86_64')) {
      throw new Error('config/benchmark/executor.yaml: benchmarks.swe-bench.images.source=epoch 需要允许非官方镜像且使用 ARM64')
    }
    config.execution = require('../benchmark-protocol/execution.cjs').normalizeExecutionConfig(config.execution)
  }
  return config
}

module.exports = { loadProjectConfig, parseEvaluatorEnv, warnLegacy, legacySettings }

if (require.main === module) {
  try {
    const explicitEnv = process.argv[5] === '--deployment' && process.argv[6] === '--env-overrides'
    const input = explicitEnv ? fs.readFileSync(0, 'utf8') : ''
    const parsed = parseEvaluatorEnv(input ? input.replace(/\n$/, '').split('\n') : [])
    const config = loadProjectConfig(process.argv[2], { configDir: process.argv[3], pathBaseDir: process.argv[4], ...(explicitEnv ? { deploymentOverrides: parsed.overrides } : {}) })
    process.stdout.write(JSON.stringify(config))
    if (process.argv[5] === '--deployment') process.stdout.write(`\n${config.imagePool.enabled}\n${config.imagePool.macDiskPath || ''}\n`)
    if (explicitEnv) {
      if (parsed.passthrough.length) process.stdout.write(`${parsed.passthrough.join('\n')}\n`)
      console.error(`Evaluator 生效配置：maxConcurrency=${config.maxConcurrency}，imagePool.enabled=${config.imagePool.enabled}，imagePool.prefetchEnabled=${config.imagePool.prefetchEnabled}，imagePool.maxPulls=${config.imagePool.maxPulls}`)
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
