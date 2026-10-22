'use strict'

const { createHash } = require('node:crypto')

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function legacyNormalize(value) {
  if (Array.isArray(value)) return value.map(legacyNormalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, legacyNormalize(item)]))
  return value
}

function fingerprintSource(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function legacySourceDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(legacyNormalize(value))).digest('hex')}`
}

module.exports = { fingerprintSource, legacySourceDigest }
