#!/usr/bin/env node
/**
 * 承载 Next standalone + WSS 控制通道的单进程服务器（IF-N05）。
 *
 * Next 的 Route Handler 拿不到 `upgrade` 事件，所以控制通道不能做成普通 API 路由。
 * 这里接管 HTTP server：`/api/reliability/client/v1/control` 走 WebSocket，
 * 其余请求原样交给 Next。
 *
 * 由 scripts/start.js 在 standalone 模式下拉起，替代直接 `node .next/standalone/server.js`。
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'production'

const http = require('http')
const path = require('path')

const { upgradeToWebSocket } = require('./ws-endpoint')

const CONTROL_PATH = '/api/reliability/client/v1/control'
const PORT = Number(process.env.PORT || 3000)
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0'
const HEARTBEAT_MS = 30_000

const STANDALONE_ROOT = path.join(__dirname, '..', '.next', 'standalone')

/**
 * 控制面业务逻辑跑在 Next 的模块图里（用到 @/ 别名与 Prisma 单例），
 * 因此这里通过 Next 暴露的内部 HTTP 接口回调，而不是直接 require TS 源码。
 */
async function callInternal(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-insight-internal': process.env.AGENT_INSIGHT_INTERNAL_TOKEN || 'local',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

function log(...args) {
  console.log('[control-server]', ...args)
}

async function main() {
  const nextDir = path.join(STANDALONE_ROOT, '.next')
  const fs = require('fs')
  if (!fs.existsSync(nextDir)) {
    console.error('[control-server] .next/standalone not found; run npm run build first')
    process.exit(1)
  }

  // Next standalone 的 server.js 会自建 server 并监听。为了接管 upgrade，
  // 这里改用 next() 编程式接口（standalone 内已内联 next 及其依赖）。
  process.chdir(STANDALONE_ROOT)
  const next = require(path.join(STANDALONE_ROOT, 'node_modules', 'next'))
  const app = next({ dev: false, dir: STANDALONE_ROOT, hostname: HOSTNAME, port: PORT })
  const handle = app.getRequestHandler()
  await app.prepare()

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[control-server] request error', err)
      res.statusCode = 500
      res.end('internal error')
    })
  })

  const sockets = new Map() // clientId -> conn

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname !== CONTROL_PATH) {
      socket.destroy()
      return
    }

    const auth = req.headers['authorization'] || ''
    const clientIdHeader = String(req.headers['x-agent-insight-client-id'] || '')
    if (!auth || !clientIdHeader) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    // 凭证校验交给 Next 侧（唯一持有 Prisma 与哈希逻辑的地方）。
    const verified = await callInternal('/api/reliability/client/v1/control-auth', {
      authorization: auth,
      clientId: clientIdHeader,
    }).catch(() => null)
    if (!verified?.ok || !verified.json?.clientId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const clientId = verified.json.clientId

    const conn = upgradeToWebSocket(req, socket, head)
    if (!conn) return

    const previous = sockets.get(clientId)
    if (previous && previous !== conn) previous.close(1012, 'replaced')
    sockets.set(clientId, conn)
    await callInternal('/api/reliability/client/v1/control-presence', {
      clientId,
      connected: true,
    }).catch(() => null)
    log(`client connected: ${clientId}`)

    let alive = true
    const timer = setInterval(() => {
      if (!alive) {
        conn.close(1001, 'heartbeat timeout')
        return
      }
      alive = false
      conn.ping()
    }, HEARTBEAT_MS)
    conn.on('pong', () => {
      alive = true
    })

    conn.on('message', async (raw) => {
      alive = true
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      if (frame?.type !== 'COMMAND_STATUS' || !frame.commandId) return
      // 回执统一交给 Next 侧处理，保证 WSS 与长轮询语义一致。
      await callInternal('/api/reliability/client/v1/control-receipt', {
        clientId,
        commandId: frame.commandId,
        status: frame.status,
        occurredAt: frame.occurredAt,
        result: frame.result,
        error: frame.error,
      }).catch((err) => log('receipt failed', err?.message || err))
    })

    conn.on('close', async () => {
      clearInterval(timer)
      if (sockets.get(clientId) === conn) sockets.delete(clientId)
      await callInternal('/api/reliability/client/v1/control-presence', {
        clientId,
        connected: false,
      }).catch(() => null)
      log(`client disconnected: ${clientId}`)
    })
  })

  // Next 侧要投递指令时回调这里。绑定 127.0.0.1，不对外暴露。
  const dispatchPort = Number(process.env.AGENT_INSIGHT_RAS_DISPATCH_PORT || PORT + 1)
  const dispatcher = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'bad json' }))
        return
      }
      const conn = sockets.get(payload.clientId)
      const delivered = conn ? conn.send(JSON.stringify(payload.frame)) : false
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ delivered, connected: Boolean(conn) }))
    })
  })
  dispatcher.listen(dispatchPort, '127.0.0.1', () => {
    log(`dispatch listener on 127.0.0.1:${dispatchPort}`)
  })

  server.listen(PORT, HOSTNAME, () => {
    log(`ready on http://${HOSTNAME}:${PORT}`)
    log(`control channel: ws://${HOSTNAME}:${PORT}${CONTROL_PATH}`)
  })

  const shutdown = () => {
    for (const conn of sockets.values()) conn.close(1001, 'server shutdown')
    server.close(() => process.exit(0))
    dispatcher.close()
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('[control-server] fatal', err)
  process.exit(1)
})
