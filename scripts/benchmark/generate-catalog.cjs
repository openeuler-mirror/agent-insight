'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const matter = require('gray-matter')

function fail(message) {
  throw new Error(`[benchmark catalog] ${message}`)
}

function readYaml(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const parsed = matter(`---\n${source}\n---\n`).data
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${filePath} 不是 YAML 对象`)
  return parsed
}

function resolveInside(packageDir, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('./')) fail(`${label} 必须是包内 ./ 相对路径`)
  const resolved = path.resolve(packageDir, relativePath)
  if (!resolved.startsWith(`${packageDir}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`${label} 不存在或越出接入包：${relativePath}`)
  }
  return resolved
}

function resolvePackageFile(packageDir, baseDir, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('.')) fail(`${label} 必须是接入包内相对路径`)
  const resolved = path.resolve(baseDir, relativePath)
  if (!resolved.startsWith(`${packageDir}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`${label} 不存在或越出接入包：${relativePath}`)
  }
  return resolved
}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  catch (error) { fail(`${label} 不是合法 JSON：${error.message}`) }
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(target) : [target]
  })
}

function digestFiles(files, baseDir) {
  const hash = createHash('sha256')
  for (const filePath of [...files].sort()) {
    hash.update(path.relative(baseDir, filePath).replaceAll(path.sep, '/')).update('\0')
      .update(fs.readFileSync(filePath)).update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function string(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) fail(`${label} 不合法`)
  return value.trim()
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`${label} 必须是正整数`)
  return value
}

const PRESENTATION_TYPES = new Set(['text', 'code', 'number', 'boolean'])
const PRESENTATION_FORMATS = new Set(['plain', 'percentage', 'bytes', 'duration-ms', 'date-time'])
const CASE_PRESENTATION_PATH = /^(input|externalCaseId|values(?:\.[A-Za-z0-9_-]+)+)$/

function optionalString(value, label) {
  return value == null ? undefined : string(value, label)
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} 必须是 ${minimum}～${maximum} 的整数`)
  }
  return value
}

function presentationColumns(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 8) fail(`${label} 必须包含 1～8 列`)
  const paths = new Set()
  return value.map((column, index) => {
    const pathValue = string(column?.path, `${label}[${index}].path`, CASE_PRESENTATION_PATH)
    if (paths.has(pathValue)) fail(`${label}[${index}].path 重复`)
    paths.add(pathValue)
    const type = string(column?.type, `${label}[${index}].type`)
    if (!PRESENTATION_TYPES.has(type)) fail(`${label}[${index}].type 不受支持`)
    const format = column?.format == null ? undefined : string(column.format, `${label}[${index}].format`)
    if (format && !PRESENTATION_FORMATS.has(format)) fail(`${label}[${index}].format 不受支持`)
    return {
      path: pathValue,
      label: string(column?.label, `${label}[${index}].label`),
      type,
      ...(column?.width == null ? {} : { width: boundedInteger(column.width, `${label}[${index}].width`, 60, 1200) }),
      ...(format ? { format } : {}),
      ...(column?.truncate == null ? {} : { truncate: boundedInteger(column.truncate, `${label}[${index}].truncate`, 1, 10000) }),
      ...(column?.description == null ? {} : { description: string(column.description, `${label}[${index}].description`) }),
    }
  })
}

function normalizeArtifactPresentation(value) {
  if (value == null) return undefined
  if (!Array.isArray(value) || value.length > 64) fail('presentation.artifacts 必须是至多 64 项的数组')
  const identities = new Set()
  return value.map((item, index) => {
    const source = string(item?.source, `presentation.artifacts[${index}].source`)
    if (!['submission', 'evidence'].includes(source)) {
      fail(`presentation.artifacts[${index}].source 不受支持`)
    }
    const name = optionalString(item?.name, `presentation.artifacts[${index}].name`)
    const kind = optionalString(item?.kind, `presentation.artifacts[${index}].kind`)
    if (Boolean(name) === Boolean(kind)) {
      fail(`presentation.artifacts[${index}] 必须且只能声明 name 或 kind`)
    }
    const identity = `${source}:${name ? `name:${name}` : `kind:${kind}`}`
    if (identities.has(identity)) fail(`presentation.artifacts[${index}] 匹配条件重复`)
    identities.add(identity)
    return {
      source,
      ...(name ? { name } : { kind }),
      label: string(item?.label, `presentation.artifacts[${index}].label`),
      order: boundedInteger(item?.order, `presentation.artifacts[${index}].order`, 0, 10000),
    }
  })
}

function normalizeDataset(source, key) {
  if (source == null) return undefined
  if (!Array.isArray(source.profiles) || !source.profiles.length) fail(`${key} 缺少 dataset.profiles`)
  const keys = new Set()
  const profiles = source.profiles.map((profile, index) => {
    const profileKey = string(profile?.key, `dataset.profiles[${index}].key`, /^[a-z0-9][a-z0-9._-]{0,63}$/)
    if (keys.has(profileKey)) fail(`${key} 的 Dataset Profile 重复：${profileKey}`)
    keys.add(profileKey)
    if (!Array.isArray(profile?.acceptedExtensions) || !profile.acceptedExtensions.length) {
      fail(`${profileKey} 缺少 acceptedExtensions`)
    }
    const acceptedExtensions = profile.acceptedExtensions.map((extension, extensionIndex) => (
      string(extension, `${profileKey}.acceptedExtensions[${extensionIndex}]`, /^\.[a-z0-9]+$/)
    ))
    return {
      key: profileKey,
      displayName: string(profile?.displayName || profileKey, `${profileKey}.displayName`),
      acceptedExtensions,
      ...(profile?.expectedCaseCount == null
        ? {}
        : { expectedCaseCount: positiveInteger(profile.expectedCaseCount, `${profileKey}.expectedCaseCount`) }),
    }
  })
  return { profiles }
}

function normalizePresentation(source, key) {
  if (source == null) return undefined
  const caseTable = source.caseTable
  if (!caseTable || typeof caseTable !== 'object' || Array.isArray(caseTable)) {
    fail(`${key} 缺少 presentation.caseTable`)
  }
  const searchPaths = Array.isArray(caseTable.searchPaths) && caseTable.searchPaths.length
    ? caseTable.searchPaths.map((item, index) => string(item, `caseTable.searchPaths[${index}]`, CASE_PRESENTATION_PATH))
    : ['externalCaseId']
  const result = {
    caseTable: {
      searchPaths,
      ...(caseTable.searchPlaceholder
        ? { searchPlaceholder: string(caseTable.searchPlaceholder, 'caseTable.searchPlaceholder') }
        : {}),
      columns: presentationColumns(caseTable.columns, 'caseTable.columns'),
    },
  }
  if (source.evaluator != null) {
    result.evaluator = {
      displayName: string(source.evaluator.displayName, 'evaluator.displayName'),
      description: string(source.evaluator.description, 'evaluator.description'),
      runMode: string(source.evaluator.runMode, 'evaluator.runMode'),
      outputDescription: string(source.evaluator.outputDescription, 'evaluator.outputDescription'),
    }
  }
  if (source.referencePanel != null) {
    result.referencePanel = {
      title: string(source.referencePanel.title, 'referencePanel.title'),
      description: string(source.referencePanel.description, 'referencePanel.description'),
      columns: presentationColumns(source.referencePanel.columns, 'referencePanel.columns'),
    }
  }
  if (source.result != null) {
    const primaryMetric = source.result.primaryMetric
    const type = string(primaryMetric?.type, 'result.primaryMetric.type')
    if (!PRESENTATION_TYPES.has(type)) fail('result.primaryMetric.type 不受支持')
    const format = primaryMetric?.format == null ? undefined : string(primaryMetric.format, 'result.primaryMetric.format')
    if (format && !PRESENTATION_FORMATS.has(format)) fail('result.primaryMetric.format 不受支持')
    result.result = {
      primaryMetric: {
        path: string(primaryMetric?.path, 'result.primaryMetric.path', /^primaryMetric\.value$/),
        label: string(primaryMetric?.label, 'result.primaryMetric.label'),
        type,
        ...(primaryMetric?.aggregateLabel == null ? {} : { aggregateLabel: string(primaryMetric.aggregateLabel, 'result.primaryMetric.aggregateLabel') }),
        ...(primaryMetric?.trueLabel == null ? {} : { trueLabel: string(primaryMetric.trueLabel, 'result.primaryMetric.trueLabel') }),
        ...(primaryMetric?.falseLabel == null ? {} : { falseLabel: string(primaryMetric.falseLabel, 'result.primaryMetric.falseLabel') }),
        ...(format ? { format } : {}),
        ...(primaryMetric?.precision == null ? {} : { precision: boundedInteger(primaryMetric.precision, 'result.primaryMetric.precision', 0, 12) }),
        ...(primaryMetric?.unit == null ? {} : { unit: string(primaryMetric.unit, 'result.primaryMetric.unit') }),
      },
    }
  }
  const artifacts = normalizeArtifactPresentation(source.artifacts)
  if (artifacts) result.artifacts = artifacts
  return result
}

function loadPackage(packageDir) {
  const yamlPath = path.join(packageDir, 'benchmark.yaml')
  const source = readYaml(yamlPath)
  const key = string(source.key, 'key', /^[a-z0-9][a-z0-9._-]{0,63}$/)
  if (source.protocols?.agentTask !== 'agent-task/v1' || source.protocols?.evaluation !== 'benchmark-evaluation/v1') {
    fail(`${key} 的协议与当前 Runtime 不兼容`)
  }
  const adapterPath = resolveInside(packageDir, source.implementation?.adapter, 'implementation.adapter')
  const datasetLoaderPath = source.implementation?.datasetLoader
    ? resolveInside(packageDir, source.implementation.datasetLoader, 'implementation.datasetLoader')
    : null
  const datasetLoaderExport = datasetLoaderPath
    ? string(source.implementation?.datasetLoaderExport, 'implementation.datasetLoaderExport', /^[A-Za-z_$][\w$]*$/)
    : null
  const evaluatorYamlPath = resolveInside(packageDir, source.implementation?.evaluator, 'implementation.evaluator')
  const caseSchemaPath = resolveInside(packageDir, source.schemas?.case, 'schemas.case')
  const resultSchemaPath = resolveInside(packageDir, source.schemas?.rawResult, 'schemas.rawResult')
  const evaluator = readYaml(evaluatorYamlPath)
  if (string(evaluator.key, 'evaluator.key') !== string(source.evaluation?.evaluatorKey, 'evaluation.evaluatorKey')) {
    fail(`${key} 的 evaluator key 与 benchmark.yaml 不一致`)
  }
  if (!['controller-container', 'script-package', 'builtin'].includes(evaluator.runtime)) {
    fail(`${key} 的 evaluator.runtime 不受支持`)
  }
  if (!['node', 'python3', 'direct'].includes(evaluator.command)) {
    fail(`${key} 的 evaluator.command 不受支持`)
  }
  const evaluatorDir = path.dirname(evaluatorYamlPath)
  const entrypoint = resolveInside(evaluatorDir, evaluator.entrypoint, 'evaluator.entrypoint')
  const smokeEntrypoint = evaluator.smokeEntrypoint
    ? resolvePackageFile(packageDir, evaluatorDir, evaluator.smokeEntrypoint, 'evaluator.smokeEntrypoint')
    : null
  const artifacts = source.submission?.artifacts
  if (!Array.isArray(artifacts) || !artifacts.length) fail(`${key} 至少声明一个 Artifact`)
  const names = new Set()
  const normalizedArtifacts = artifacts.map((artifact, index) => {
    const name = string(artifact?.name, `submission.artifacts[${index}].name`, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
    if (names.has(name)) fail(`${key} 的 Artifact 名称重复：${name}`)
    names.add(name)
    return {
      name,
      mediaType: string(artifact.mediaType, `${name}.mediaType`),
      collector: string(artifact.collector, `${name}.collector`, /^[a-z0-9][a-z0-9._/-]{0,127}$/),
      maxBytes: positiveInteger(artifact.maxBytes, `${name}.maxBytes`),
    }
  })
  const requiredCapabilities = source.executor?.requiredCapabilities
  if (!Array.isArray(requiredCapabilities) || !requiredCapabilities.length) fail(`${key} 缺少执行器能力声明`)
  const normalizedCapabilities = requiredCapabilities.map((item, index) => (
    string(item, `requiredCapabilities[${index}]`, /^[a-z0-9][a-z0-9._/-]{0,127}$/)
  ))
  if (new Set(normalizedCapabilities).size !== normalizedCapabilities.length) {
    fail(`${key} 的执行器能力声明重复`)
  }
  for (const artifact of normalizedArtifacts) {
    if (!normalizedCapabilities.includes(artifact.collector)) {
      fail(`${key} 的 Artifact collector 未列入 requiredCapabilities：${artifact.collector}`)
    }
  }
  const cpu = Number(source.evaluation?.resources?.cpu)
  if (!Number.isFinite(cpu) || cpu <= 0) fail('evaluation.resources.cpu 必须是正数')
  if (
    Number(evaluator.resources?.cpu) !== cpu
    || evaluator.resources?.memoryMiB !== source.evaluation?.resources?.memoryMiB
    || evaluator.resources?.timeoutSeconds !== source.evaluation?.defaultTimeoutSeconds
  ) {
    fail(`${key} 的 evaluator.yaml 资源限制必须与 benchmark.yaml 一致`)
  }
  const caseSchema = readJson(caseSchemaPath, `${key} Case Schema`)
  const rawResultSchema = readJson(resultSchemaPath, `${key} Result Schema`)
  const adapterExport = string(source.implementation?.adapterExport, 'implementation.adapterExport', /^[A-Za-z_$][\w$]*$/)
  const dataset = normalizeDataset(source.dataset, key)
  const presentation = normalizePresentation(source.presentation, key)
  if (datasetLoaderPath && !dataset) fail(`${key} 声明了 Dataset Loader，但没有 dataset.profiles`)
  const primaryMetricKey = string(source.result?.primaryMetric?.key, 'result.primaryMetric.key')
  const primaryMetricAggregation = source.result?.primaryMetric?.aggregation
  if (!['boolean-rate', 'mean'].includes(primaryMetricAggregation)) {
    fail(`${key} 的 result.primaryMetric.aggregation 不受支持`)
  }
  const evaluatorFiles = [...new Set([
    ...listFiles(evaluatorDir),
    ...(smokeEntrypoint ? listFiles(path.dirname(smokeEntrypoint)) : []),
  ])]
  const files = [
    yamlPath,
    adapterPath,
    ...(datasetLoaderPath ? [datasetLoaderPath] : []),
    caseSchemaPath,
    resultSchemaPath,
    ...evaluatorFiles,
  ]
  return {
    key,
    packageDir,
    adapterPath,
    adapterExport,
    datasetLoaderPath,
    datasetLoaderExport,
    manifest: {
      adapterKey: key,
      displayName: string(source.displayName, 'displayName'),
      protocols: {
        agentTask: string(source.protocols?.agentTask, 'protocols.agentTask'),
        evaluation: string(source.protocols?.evaluation, 'protocols.evaluation'),
      },
      requiredCapabilities: normalizedCapabilities,
      defaultTimeoutSeconds: positiveInteger(source.executor?.defaultTimeoutSeconds, 'executor.defaultTimeoutSeconds'),
      requiredArtifacts: normalizedArtifacts,
      schemas: { case: caseSchema, rawResult: rawResultSchema },
      evaluation: {
        evaluatorKey: string(source.evaluation?.evaluatorKey, 'evaluation.evaluatorKey'),
        defaultTimeoutSeconds: positiveInteger(source.evaluation?.defaultTimeoutSeconds, 'evaluation.defaultTimeoutSeconds'),
        defaultResources: {
          cpu,
          memoryMiB: positiveInteger(source.evaluation?.resources?.memoryMiB, 'evaluation.resources.memoryMiB'),
        },
      },
      result: {
        primaryMetric: {
          key: primaryMetricKey,
          aggregation: primaryMetricAggregation,
        },
      },
      ...(dataset ? { dataset } : {}),
      ...(presentation ? { presentation } : {}),
    },
    evaluator: {
      key: evaluator.key,
      benchmarkKey: key,
      runtime: evaluator.runtime,
      command: string(evaluator.command, 'evaluator.command'),
      entrypoint,
      ...(smokeEntrypoint ? { smokeEntrypoint } : {}),
      artifactDigest: digestFiles(evaluatorFiles, evaluatorDir),
      network: evaluator.network === 'allow' ? 'allow' : 'deny',
      resources: {
        cpu: Number(evaluator.resources.cpu),
        memoryMiB: evaluator.resources.memoryMiB,
        timeoutSeconds: evaluator.resources.timeoutSeconds,
      },
      requiredArtifacts: normalizedArtifacts,
      rawResultSchema,
    },
    packageDigest: digestFiles(files, packageDir),
  }
}

function toImportPath(fromDir, targetPath) {
  const value = path.relative(fromDir, targetPath).replaceAll(path.sep, '/')
  return value.startsWith('.') ? value : `./${value}`
}

function generate(rootDir = path.resolve(__dirname, '../..')) {
  const benchmarksDir = path.join(rootDir, 'benchmarks')
  const outputDir = path.join(rootDir, 'generated', 'benchmark-catalog')
  const packages = fs.readdirSync(benchmarksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(benchmarksDir, entry.name, 'benchmark.yaml')))
    .map((entry) => loadPackage(path.join(benchmarksDir, entry.name)))
    .sort((left, right) => left.key.localeCompare(right.key))
  if (!packages.length) fail('至少需要一个 Benchmark 接入包')
  const seen = new Set()
  for (const item of packages) {
    if (seen.has(item.key)) fail(`Benchmark key 重复：${item.key}`)
    seen.add(item.key)
  }
  fs.mkdirSync(outputDir, { recursive: true })
  const manifestSource = [
    '// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog',
    '',
    "import type { BenchmarkManifest } from '../../packages/benchmark-protocol/src/contracts'",
    '',
    `export const generatedBenchmarkManifests = ${JSON.stringify(Object.fromEntries(packages.map((item) => [item.key, item.manifest])), null, 2)} as const satisfies Record<string, BenchmarkManifest>`,
    '',
    'export function getGeneratedBenchmarkManifest(key: keyof typeof generatedBenchmarkManifests): BenchmarkManifest {',
    '  return generatedBenchmarkManifests[key]',
    '}',
    '',
  ].join('\n')
  const imports = packages.map((item, index) => (
    `import { ${item.adapterExport} as adapter${index} } from '${toImportPath(outputDir, item.adapterPath).replace(/\.ts$/, '')}'`
  ))
  const adaptersSource = [
    '// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog',
    '',
    "import type { BenchmarkAdapter } from '../../packages/benchmark-protocol/src/evaluation-contracts'",
    ...imports,
    '',
    `export const generatedBenchmarkAdapters: readonly BenchmarkAdapter[] = [${packages.map((_, index) => `adapter${index}`).join(', ')}]`,
    '',
  ].join('\n')
  const packagesWithLoaders = packages.filter((item) => item.datasetLoaderPath)
  const loaderImports = packagesWithLoaders.map((item, index) => (
    `import { ${item.datasetLoaderExport} as loader${index} } from '${toImportPath(outputDir, item.datasetLoaderPath).replace(/\.ts$/, '')}'`
  ))
  const loadersSource = [
    '// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog',
    '',
    "import type { BenchmarkDatasetLoader } from '../../packages/benchmark-protocol/src/contracts'",
    ...loaderImports,
    '',
    'export type GeneratedBenchmarkDatasetLoader = { adapterKey: string; loader: BenchmarkDatasetLoader }',
    `export const generatedBenchmarkDatasetLoaders: readonly GeneratedBenchmarkDatasetLoader[] = [${packagesWithLoaders.map((item, index) => `{ adapterKey: ${JSON.stringify(item.key)}, loader: loader${index} }`).join(', ')}]`,
    '',
  ].join('\n')
  const descriptors = packages.map((item) => ({
    ...item.evaluator,
    entrypoint: path.relative(outputDir, item.evaluator.entrypoint).replaceAll(path.sep, '/'),
    ...(item.evaluator.smokeEntrypoint
      ? { smokeEntrypoint: path.relative(outputDir, item.evaluator.smokeEntrypoint).replaceAll(path.sep, '/') }
      : {}),
  }))
  let descriptorJson = JSON.stringify(descriptors, null, 2)
  descriptorJson = descriptorJson.replace(
    /"(entrypoint|smokeEntrypoint)": "([^"]+)"/g,
    '"$1": path.resolve(__dirname, "$2")',
  )
  const evaluatorSource = [
    "'use strict'",
    '',
    '// AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog',
    '',
    "const path = require('node:path')",
    '',
    `const generatedEvaluatorDescriptors = ${descriptorJson}`,
    '',
    'module.exports = { generatedEvaluatorDescriptors }',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(outputDir, 'manifests.ts'), manifestSource)
  fs.writeFileSync(path.join(outputDir, 'adapters.ts'), adaptersSource)
  fs.writeFileSync(path.join(outputDir, 'dataset-loaders.ts'), loadersSource)
  fs.writeFileSync(path.join(outputDir, 'evaluators.cjs'), evaluatorSource)
  fs.writeFileSync(path.join(outputDir, 'catalog-lock.json'), `${JSON.stringify({
    notice: 'AUTO-GENERATED FILE. DO NOT EDIT. Run: npm run benchmark:catalog',
    packages: packages.map((item) => ({ key: item.key, digest: item.packageDigest, evaluatorDigest: item.evaluator.artifactDigest })),
  }, null, 2)}\n`)
  return packages.map((item) => item.key)
}

if (require.main === module) console.log(`[benchmark catalog] generated: ${generate().join(', ')}`)

module.exports = { generate, loadPackage }
