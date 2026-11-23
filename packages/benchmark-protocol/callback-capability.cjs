'use strict'

function callbackCapabilityHeaders(request) {
  if (request.callbackHeaders === undefined) return {}
  const headers = request.callbackHeaders
  const key = 'x-agent-insight-callback-token'
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)
    || Object.keys(headers).length !== 1 || !Object.prototype.hasOwnProperty.call(headers, key)
    || typeof headers[key] !== 'string' || headers[key].length > 4096
    || !/^bcap_[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(headers[key])) {
    throw Object.assign(new Error('Invalid Benchmark callback capability headers'), {
      code: 'CALLBACK_HEADERS_INVALID', status: 400, retryable: false,
    })
  }
  return { [key]: headers[key] }
}

module.exports = { callbackCapabilityHeaders }
