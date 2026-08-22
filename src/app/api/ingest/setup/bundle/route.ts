import { spawn } from 'child_process'
import fs from 'node:fs'
import path from 'node:path'

import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'

export const dynamic = 'force-dynamic'

/**
 * 制品下发：把服务端自身安装目录里的源码打成 tar.gz 返回。
 *
 * 存在的理由：安装脚本原先只能 `npm pack` 取制品，于是
 *   - 在仓库外执行 → 拿到 npm 上的旧包（版本号相同但内容滞后）
 *   - 内网/离线 → 直接失败
 * 都会导致 RAS / 常驻客户端装不上。服务端自己就有这些文件，
 * 而 curl 命令里唯一确定可达的就是服务端 —— 让它直接下发，
 * 安装结果便与执行目录和 npm registry 无关。
 *
 * 与 /api/ingest/setup/opencode 下发单文件是同一模式，只是这里要整目录。
 */
const BUNDLES: Record<string, string[]> = {
  // RAS 运行时 + 安装器（install-ras.js 按 __dirname/.. 定位 agent_ras）
  ras: ['scripts/install-ras.js', 'agent_ras'],
  // 常驻客户端：安装器 + 守护进程 + WSS 客户端；FI 组件安装由 install-ras-client 串联。
  // config_sync.js 必须带上：客户端靠它把配置合并进 RAS 实际读取的 config.json，
  // 缺了会静默跳过运行时写入（页面显示已写入，RAS 却读不到新值）。
  client: [
    'scripts/install-ras-client.js',
    'scripts/reliability-client.cjs',
    'scripts/ws-client.cjs',
    'scripts/install-fault-injection.js',
    'scripts/fi-worker.js',
    'agent_ras/platform_adapter/opencode/config_sync.js',
    'agent_fault_injection',
  ],
}

/** 排除构建产物与缓存：它们体积大、平台相关，且客户端会自行重建。 */
const TAR_EXCLUDES = [
  '--exclude=__pycache__',
  '--exclude=*.pyc',
  '--exclude=.pytest_cache',
  '--exclude=build',
  '--exclude=*.egg-info',
  '--exclude=venv',
  '--exclude=.venv',
]

export async function GET(req: Request) {
  const { username, apiKey } = await resolveUser(req)
  if (apiKey && !username) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!username && !process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER) {
    return NextResponse.json(
      { error: 'unauthorized', detail: 'x-witty-api-key required' },
      { status: 401 },
    )
  }

  const name = new URL(req.url).searchParams.get('name') || ''
  // 白名单查表，绝不把参数拼进路径 —— 否则就是任意文件读取。
  const entries = Object.prototype.hasOwnProperty.call(BUNDLES, name) ? BUNDLES[name] : null
  if (!entries) {
    return NextResponse.json(
      { error: 'unknown_bundle', allowed: Object.keys(BUNDLES) },
      { status: 400 },
    )
  }

  const root = process.cwd()
  const present = entries.filter((rel) => fs.existsSync(path.join(root, rel)))
  if (!present.length) {
    return NextResponse.json(
      { error: 'bundle_unavailable', detail: `no source files for "${name}" under ${root}` },
      { status: 503 },
    )
  }

  const tar = spawn('tar', ['-czf', '-', ...TAR_EXCLUDES, ...present], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  tar.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      tar.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      tar.stdout.on('end', () => controller.close())
      tar.on('error', (err) => controller.error(err))
      tar.on('close', (code) => {
        if (code !== 0) {
          console.error(`[setup/bundle] tar exited ${code}: ${stderr.trim()}`)
          controller.error(new Error(`tar exited ${code}`))
        }
      })
    },
    cancel() {
      tar.kill('SIGTERM')
    },
  })

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="agent-insight-${name}.tar.gz"`,
      'Cache-Control': 'no-store',
    },
  })
}
