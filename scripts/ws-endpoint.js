/**
 * 最小 RFC 6455 服务端实现（仅本项目控制通道需要的子集）。
 *
 * 为什么不用 `ws`：AGENTS.md §9 规定新增依赖需用户授权。控制通道只需要
 * 文本帧 + ping/pong + close，握手与帧格式都在 Node 内置能力范围内，
 * 因此这里自带一份，避免为一个端点引入运行时依赖。
 *
 * 不支持（本通道用不到）：扩展协商（permessage-deflate）、二进制帧的应用层投递、
 * 分片消息超过 maxPayload 的续传。
 */
const crypto = require('crypto')

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const DEFAULT_MAX_PAYLOAD = 1 * 1024 * 1024

function acceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + GUID).digest('base64')
}

/** 组一个服务端帧（不掩码）。 */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode // FIN + opcode
  return Buffer.concat([header, data])
}

class WsConnection {
  constructor(socket, opts = {}) {
    this.socket = socket
    this.maxPayload = opts.maxPayload || DEFAULT_MAX_PAYLOAD
    this.buffer = Buffer.alloc(0)
    this.closed = false
    this.handlers = { message: [], close: [], error: [], pong: [] }
    this.fragmentOp = null
    this.fragments = []

    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('close', () => this._fireClose())
    socket.on('error', (err) => {
      this._fire('error', err)
      this._fireClose()
    })
  }

  on(event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn)
    return this
  }

  _fire(event, ...args) {
    for (const fn of this.handlers[event] || []) {
      try {
        fn(...args)
      } catch {
        /* handler errors must not kill the socket loop */
      }
    }
  }

  _fireClose() {
    if (this.closed) return
    this.closed = true
    this._fire('close')
  }

  send(data) {
    if (this.closed || this.socket.destroyed) return false
    try {
      this.socket.write(encodeFrame(OP_TEXT, data))
      return true
    } catch {
      return false
    }
  }

  ping() {
    if (this.closed || this.socket.destroyed) return
    try {
      this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)))
    } catch {
      /* ignore */
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed || this.socket.destroyed) {
      this.closed = true
      return
    }
    const reasonBuf = Buffer.from(String(reason), 'utf8')
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload))
    } catch {
      /* ignore */
    }
    this.closed = true
    this.socket.end()
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this._readFrame()
      if (!frame) break
      this._handleFrame(frame)
      if (this.closed) break
    }
  }

  /** 解析一帧；数据不足返回 null，等待更多字节。 */
  _readFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null

    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2

    if (len === 126) {
      if (buf.length < offset + 2) return null
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(this.maxPayload)) {
        this.close(1009, 'payload too large')
        return null
      }
      len = Number(big)
      offset += 8
    }

    if (len > this.maxPayload) {
      this.close(1009, 'payload too large')
      return null
    }

    // RFC 6455: 客户端发往服务端的帧必须掩码。
    if (!masked) {
      this.close(1002, 'client frames must be masked')
      return null
    }
    if (buf.length < offset + 4) return null
    const maskKey = buf.subarray(offset, offset + 4)
    offset += 4

    if (buf.length < offset + len) return null
    const payload = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) {
      payload[i] = buf[offset + i] ^ maskKey[i & 3]
    }
    this.buffer = buf.subarray(offset + len)
    return { fin, opcode, payload }
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame
    if (opcode === OP_CLOSE) {
      this.close(1000, '')
      this._fireClose()
      return
    }
    if (opcode === OP_PING) {
      try {
        this.socket.write(encodeFrame(OP_PONG, payload))
      } catch {
        /* ignore */
      }
      return
    }
    if (opcode === OP_PONG) {
      this._fire('pong')
      return
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (fin) {
        if (opcode === OP_TEXT) this._fire('message', payload.toString('utf8'))
        return
      }
      this.fragmentOp = opcode
      this.fragments = [payload]
      return
    }
    if (opcode === OP_CONT && this.fragmentOp !== null) {
      this.fragments.push(payload)
      if (fin) {
        const full = Buffer.concat(this.fragments)
        const op = this.fragmentOp
        this.fragmentOp = null
        this.fragments = []
        if (op === OP_TEXT) this._fire('message', full.toString('utf8'))
      }
    }
  }
}

/**
 * 完成握手并返回连接对象。握手失败时写 HTTP 错误并销毁 socket，返回 null。
 */
function upgradeToWebSocket(req, socket, head, opts = {}) {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }

  socket.setNoDelay(true)
  socket.setKeepAlive(true, 30_000)
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'),
  )

  const conn = new WsConnection(socket, opts)
  if (head && head.length) conn._onData(head)
  return conn
}

module.exports = { upgradeToWebSocket, encodeFrame, WsConnection }
