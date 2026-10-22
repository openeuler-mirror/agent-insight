'use strict'

function remoteImage(image) {
  const host = String(image || '').split('/')[0]
  return String(image || '').includes('/') && (host.includes('.') || host.includes(':') || host === 'localhost')
}

function runtimeDescriptor(descriptor, prefix = process.env.EVALUATOR_RUNTIME_IMAGE_PREFIX || '') {
  if (!prefix || remoteImage(descriptor.image)) return descriptor
  prefix = prefix.replace(/\/+$/, '')
  if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/.test(prefix) || !remoteImage(`${prefix}/runtime`)) {
    throw new Error('EVALUATOR_RUNTIME_IMAGE_PREFIX must be registry/namespace')
  }
  return { ...descriptor, image: `${prefix}/${descriptor.image}` }
}

module.exports = { runtimeDescriptor, remoteImage }
