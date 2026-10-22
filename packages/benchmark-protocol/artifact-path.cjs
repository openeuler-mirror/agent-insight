'use strict'

/** @param {unknown} value */
function isEvidencePath(value) {
  return typeof value === 'string' && value.length <= 512
    && value.split('/').length <= 16
    && value.split('/').every(segment => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment))
}

module.exports = { isEvidencePath }
