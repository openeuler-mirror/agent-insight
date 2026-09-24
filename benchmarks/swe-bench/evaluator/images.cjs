'use strict'

const { SweBenchImageResolver, imageProxyPrefix, verifiedImageMirrorRepositories } = require('./index.cjs')

function describeImages(payload, arch) {
  const instance = payload?.instance
  if (!instance || !/^[a-z0-9_.-]{1,200}$/i.test(String(instance.instance_id || ''))) {
    throw new Error('SWE-bench image preparation requires a valid instance_id')
  }
  const daemonArch = ['amd64', 'x86_64'].includes(arch) ? 'x86_64' : arch === 'aarch64' ? 'arm64' : arch
  const selected = new SweBenchImageResolver().imageFor(String(instance.image || ''), instance.instance_id, daemonArch)
  const proxy = imageProxyPrefix()
  const mirrors = selected.source === 'official' && selected.arch === 'x86_64' ? verifiedImageMirrorRepositories() : []
  return [{
    key: selected.image,
    arch: selected.arch,
    references: [
      ...mirrors.map((repository) => `${repository}:${instance.instance_id}`),
      ...(proxy ? [`${proxy}/${selected.image}`] : []),
      selected.image,
    ],
    context: { ...selected, daemonArch, imageMirrorRepositories: mirrors, imageProxyPrefix: proxy || null },
  }]
}

module.exports = { describeImages }
