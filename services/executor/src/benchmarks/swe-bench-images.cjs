'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

function imageError(code, message, status = 422, retryable = false) {
  return Object.assign(new Error(message), { code, status, retryable })
}

const DEFAULT_VERIFIED_IMAGE_MIRROR_REPOSITORIES = [
  'swr.cn-east-3.myhuaweicloud.com/agent-insight/swebench-verified-x86-64-a',
  'swr.cn-east-3.myhuaweicloud.com/agent-insight/swebench-verified-x86-64-b',
]

function imageRepository(image) {
  const withoutDigest = image.split('@')[0]
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest
}

function imageProxyPrefix(config, errorFactory = imageError) {
  const configured = config.proxyPrefix
  const prefix = String(configured || '')
    .trim()
    .replace(/\/+$/, '')
  if (prefix && !/^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*$/i.test(prefix)) {
    throw errorFactory('SWE_IMAGE_CONFIGURATION_INVALID', 'SWE-bench 镜像代理前缀不合法', 500)
  }
  return prefix
}

function verifiedImageMirrorRepositories(config, errorFactory = imageError) {
  const configured = (config.verifiedMirrorRepositories
    ?? DEFAULT_VERIFIED_IMAGE_MIRROR_REPOSITORIES).join(',')
  if (!configured) return []
  const repositories = configured.split(',').map((value) => value.trim())
  if (
    repositories.length > 8
    || repositories.some((repository) => (
      !repository
      || !/^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/.test(repository)
    ))
  ) {
    throw errorFactory(
      'SWE_IMAGE_CONFIGURATION_INVALID',
      'SWE-bench Verified 镜像仓库配置不合法',
      500,
    )
  }
  return [...new Set(repositories)]
}

class SweBenchImageResolver {
  constructor({ processRunner, config, errorFactory = imageError }) {
    this.processRunner = processRunner
    this.config = typeof config === 'function' ? config : () => config
    this.errorFactory = errorFactory
  }

  async dockerArchitecture(signal) {
    const result = await this.processRunner(
      'docker',
      ['info', '--format', '{{.Architecture}}'],
      { signal, errorCode: 'DOCKER_UNAVAILABLE' },
    )
    const value = result.stdout.trim().toLowerCase()
    if (['amd64', 'x86_64'].includes(value)) return 'x86_64'
    if (['arm64', 'aarch64'].includes(value)) return 'arm64'
    throw this.errorFactory('SWE_ARCH_UNSUPPORTED', `不支持 Docker 架构：${value}`, 422)
  }

  imageFor(jobImage, instanceId, arch, config = this.config()) {
    if (!/^[a-z0-9_.-]{1,200}$/i.test(String(instanceId || ''))) throw this.errorFactory('SWE_INSTANCE_INVALID', 'SWE-bench instance_id 不合法', 422)
    if (!['x86_64', 'arm64'].includes(arch)) throw this.errorFactory('SWE_ARCH_UNSUPPORTED', `不支持 Docker 架构：${arch}`, 422)
    const source = config.source
    const configuredArch = config.arch
    const allowNonOfficial = config.allowNonOfficial
    if (!['official', 'epoch'].includes(source) || !['auto', 'x86_64', 'arm64'].includes(configuredArch)) {
      throw this.errorFactory('SWE_IMAGE_CONFIGURATION_INVALID', 'SWE-bench 镜像配置不合法', 500)
    }
    const selectedArch = configuredArch === 'auto' ? arch : configuredArch
    if (selectedArch !== arch) {
      throw this.errorFactory('SWE_IMAGE_ARCH_MISMATCH', '配置的镜像架构与 Docker daemon 不一致', 422)
    }
    if (source === 'epoch') {
      if (!allowNonOfficial || selectedArch !== 'arm64') {
        throw this.errorFactory(
          'SWE_NON_OFFICIAL_IMAGE_FORBIDDEN',
          'Epoch 镜像只允许在显式开启的 ARM64 smoke 中使用',
          422,
        )
      }
      return {
        image: `ghcr.io/epoch-research/swe-bench.eval.arm64.${instanceId}:latest`,
        source,
        arch: selectedArch,
        formalEligible: false,
      }
    }
    const image = selectedArch === 'arm64'
      ? jobImage.replace('.x86_64.', '.arm64.')
      : jobImage.replace('.arm64.', '.x86_64.')
    if (!/^swebench\/sweb\.eval\.(x86_64|arm64)\.[a-z0-9_.-]+:[a-z0-9_.-]+$/i.test(image)) {
      throw this.errorFactory('SWE_IMAGE_FORBIDDEN', 'SWE-bench Case 镜像不在官方白名单', 422)
    }
    return {
      image,
      source,
      arch: selectedArch,
      formalEligible: selectedArch === 'x86_64',
    }
  }

  describeImages(payload, arch) {
    const instance = payload?.instance
    const daemonArch = ['amd64', 'x86_64'].includes(arch) ? 'x86_64' : arch === 'aarch64' ? 'arm64' : arch
    const config = this.config()
    const selected = this.imageFor(String(instance?.image || ''), instance?.instance_id, daemonArch, config)
    const proxy = imageProxyPrefix(config, this.errorFactory)
    const mirrors = selected.source === 'official' && selected.arch === 'x86_64' ? verifiedImageMirrorRepositories(config, this.errorFactory) : []
    return [{
      key: selected.image, arch: selected.arch,
      references: [...mirrors.map(repository => `${repository}:${instance.instance_id}`), ...(proxy ? [`${proxy}/${selected.image}`] : []), selected.image],
      context: { ...selected, daemonArch, imageMirrorRepositories: mirrors, imageProxyPrefix: proxy || null },
    }]
  }

  async resolve(jobImage, instanceId, workDir, signal, { expectedArch } = {}) {
    const frozenPath = path.join(workDir, 'resolved-image.json')
    try {
      return JSON.parse(await fs.readFile(frozenPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const daemonArch = await this.dockerArchitecture(signal)
    if (expectedArch && daemonArch !== (expectedArch === 'amd64' ? 'x86_64' : expectedArch)) throw this.errorFactory('SWE_IMAGE_ARCH_MISMATCH', '任务镜像架构与 Docker daemon 不一致', 422)
    const [plan] = this.describeImages({ instance: { image: jobImage, instance_id: instanceId } }, daemonArch)
    const { daemonArch: ignored, imageMirrorRepositories: mirrorRepositories, imageProxyPrefix: proxyPrefix, ...selected } = plan.context
    const proxyImage = proxyPrefix ? `${proxyPrefix}/${selected.image}` : null
    const mirrorImages = mirrorRepositories.map(repository => `${repository}:${instanceId}`)
    const inspectArgs = [
      'image', 'inspect', selected.image,
      '--format', '{{json .RepoDigests}}|{{.Id}}',
    ]
    let inspected
    let resolvedImageReference = selected.image
    try {
      inspected = await this.processRunner('docker', inspectArgs, {
        signal,
        errorCode: 'SWE_IMAGE_NOT_LOCAL',
        retryable: false,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      let pulled = false
      for (const mirrorImage of mirrorImages) {
        try {
          await this.processRunner('docker', ['pull', mirrorImage], {
            signal,
            errorCode: 'SWE_IMAGE_MIRROR_UNAVAILABLE',
          })
          await this.processRunner('docker', ['tag', mirrorImage, selected.image], {
            signal,
            errorCode: 'SWE_IMAGE_TAG_FAILED',
          })
          resolvedImageReference = mirrorImage
          pulled = true
          break
        } catch (error) {
          if (signal?.aborted) throw error
        }
      }
      if (!pulled && proxyImage) {
        try {
          await this.processRunner('docker', ['pull', proxyImage], {
            signal,
            errorCode: 'SWE_IMAGE_PROXY_UNAVAILABLE',
          })
          await this.processRunner('docker', ['tag', proxyImage, selected.image], {
            signal,
            errorCode: 'SWE_IMAGE_TAG_FAILED',
          })
          resolvedImageReference = proxyImage
          pulled = true
        } catch (error) {
          if (signal?.aborted) throw error
        }
      }
      if (!pulled) {
        await this.processRunner('docker', ['pull', selected.image], {
          signal,
          errorCode: 'SWE_IMAGE_UNAVAILABLE',
        })
      }
      inspected = await this.processRunner('docker', inspectArgs, {
        signal,
        errorCode: 'SWE_IMAGE_INSPECT_FAILED',
      })
    }
    const separator = inspected.stdout.lastIndexOf('|')
    const digestsJson = separator >= 0 ? inspected.stdout.slice(0, separator) : inspected.stdout
    const localImageId = separator >= 0 ? inspected.stdout.slice(separator + 1).trim() : ''
    let digests
    try { digests = JSON.parse(digestsJson.trim()) } catch {}
    const repositories = [imageRepository(selected.image)]
    repositories.push(...mirrorImages.map(imageRepository))
    if (proxyImage) repositories.push(imageRepository(proxyImage))
    const repositoryDigest = Array.isArray(digests)
      ? digests.find((value) => repositories.some((repository) => (
          String(value).startsWith(`${repository}@sha256:`)
        )))
      : null
    const pinnedImage = repositoryDigest
      || (/^sha256:[0-9a-f]{64}$/i.test(localImageId) ? localImageId : null)
    if (!pinnedImage) {
      throw this.errorFactory('SWE_IMAGE_DIGEST_MISSING', '无法固定 Case 镜像 digest', 500)
    }
    const frozen = {
      ...selected,
      daemonArch,
      pinnedImage,
      localImageId,
      resolvedImageReference,
      imageMirrorRepositories: mirrorRepositories,
      imageProxyPrefix: proxyPrefix || null,
    }
    const temporary = `${frozenPath}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify(frozen, null, 2), { mode: 0o600 })
    await fs.rename(temporary, frozenPath)
    return frozen
  }
}

module.exports = { SweBenchImageResolver, imageProxyPrefix, verifiedImageMirrorRepositories }
