/**
 * 最小 RFC 6455 客户端（配合 scripts/ws-endpoint.js 的服务端实现）。
 * 自带而非引入 `ws`：新增依赖需用户授权（AGENTS.md §9），而控制通道只用到文本帧。
 *
 * 与服务端实现的关键差异：客户端发出的帧**必须掩码**。
 */
const crypto = require('crypto')
const http = require('http')
const https = require('https')

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa
const MAX_PAYLOAD = 1 * 1024 * 1024

function encodeMaskedFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  const mask = crypto.randomBytes(4)
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

/**
 * 连接并返回一个简单的连接对象。
 * 回调：onOpen / onMessage(text) / onClose(err?)
 */
function connectWebSocket(urlStr, { headers = {}, handshakeTimeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const isTls = url.protocol === 'wss:'
    const lib = isTls ? https : http
    const key = crypto.randomBytes(16).toString('base64')
    const expectedAccept = crypto.createHash('sha1').update(key + GUID).digest('base64')

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isTls ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    })

    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error('websocket handshake timeout'))
    }, handshakeTimeoutMs)

    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer)
      if (res.headers['sec-websocket-accept'] !== expectedAccept) {
        socket.destroy()
        reject(new Error('bad Sec-WebSocket-Accept'))
        return
      }
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 30_000)

      const handlers = { message: [], close: [], ping: [] }
      let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
      let closed = false
      let fragOp = null
      let frags = []

      const conn = {
        on(event, fn) {
          if (handlers[event]) handlers[event].push(fn)
          return conn
        },
        send(text) {
          if (closed || socket.destroyed) return false
          try {
            socket.write(encodeMaskedFrame(OP_TEXT, text))
            return true
          } catch {
            return false
          }
        },
        close(code = 1000) {
          if (closed || socket.destroyed) {
            closed = true
            return
          }
          const payload = Buffer.alloc(2)
          payload.writeUInt16BE(code, 0)
          try {
            socket.write(encodeMaskedFrame(OP_CLOSE, payload))
          } catch {
            /* ignore */
          }
          closed = true
          socket.end()
        },
        get destroyed() {
          return closed || socket.destroyed
        },
      }

      function fire(event, ...args) {
        for (const fn of handlers[event] || []) {
          try {
            fn(...args)
          } catch {
            /* ignore */
          }
        }
      }

      function fireClose(err) {
        if (closed) return
        closed = true
        fire('close', err)
      }

      function readFrame() {
        if (buffer.length < 2) return null
        const fin = (buffer[0] & 0x80) !== 0
        const opcode = buffer[0] & 0x0f
        const masked = (buffer[1] & 0x80) !== 0
        let len = buffer[1] & 0x7f
        let offset = 2
        if (len === 126) {
          if (buffer.length < offset + 2) return null
          len = buffer.readUInt16BE(offset)
          offset += 2
        } else if (len === 127) {
          if (buffer.length < offset + 8) return null
          const big = buffer.readBigUInt64BE(offset)
          if (big > BigInt(MAX_PAYLOAD)) {
            conn.close(1009)
            return null
          }
          len = Number(big)
          offset += 8
        }
        if (len > MAX_PAYLOAD) {
          conn.close(1009)
          return null
        }
        let mask = null
        if (masked) {
          if (buffer.length < offset + 4) return null
          mask = buffer.subarray(offset, offset + 4)
          offset += 4
        }
        if (buffer.length < offset + len) return null
        let payload = buffer.subarray(offset, offset + len)
        if (mask) {
          const out = Buffer.allocUnsafe(len)
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
          payload = out
        }
        buffer = buffer.subarray(offset + len)
        return { fin, opcode, payload }
      }

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const frame = readFrame()
          if (!frame) break
          const { fin, opcode, payload } = frame
          if (opcode === OP_CLOSE) {
            conn.close(1000)
            fireClose()
            break
          } else if (opcode === OP_PING) {
            // 上报给调用方做保活判活：收到 ping 说明对端还在。
            fire('ping')
            try {
              socket.write(encodeMaskedFrame(OP_PONG, payload))
            } catch {
              /* ignore */
            }
          } else if (opcode === OP_TEXT) {
            if (fin) fire('message', payload.toString('utf8'))
            else {
              fragOp = OP_TEXT
              frags = [payload]
            }
          } else if (opcode === 0x0 && fragOp === OP_TEXT) {
            frags.push(payload)
            if (fin) {
              fire('message', Buffer.concat(frags).toString('utf8'))
              fragOp = null
              frags = []
            }
          }
        }
      })
      socket.on('close', () => fireClose())
      socket.on('error', (err) => fireClose(err))

      resolve(conn)
    })

    req.on('response', (res) => {
      clearTimeout(timer)
      reject(new Error(`websocket upgrade rejected: HTTP ${res.statusCode}`))
      res.resume()
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    req.end()
  })
}

module.exports = { connectWebSocket }
