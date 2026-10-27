/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function normalizeClientBaseUrl(reqUrl: URL, req: Request): string {
  const forwardedHost = req.headers.get('x-forwarded-host')
  const forwardedProto = req.headers.get('x-forwarded-proto')
  const host = forwardedHost || reqUrl.host
  const proto = forwardedProto || reqUrl.protocol.replace(':', '')
  const base = new URL(`${proto}://${host}`)
  if (base.hostname === '0.0.0.0' || base.hostname === '::' || base.hostname === '[::]') {
    base.hostname = '127.0.0.1'
  }
  return base.origin
}

/**
 * IF-N02：常驻客户端一键安装脚本。
 *
 * 安装令牌通过 `--token` 传入，不写进脚本正文 —— 脚本本身可被缓存/转发，
 * 令牌不应随之泄漏。
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const platform = url.searchParams.get('platform') || 'unix'
  const base = normalizeClientBaseUrl(url, req)

  if (platform === 'windows') {
    return new NextResponse(
      'Windows 暂不支持自动注册为系统服务；本期仅支持 Linux (systemd) 与 macOS (launchd)。\n',
      { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    )
  }

  const script = `#!/usr/bin/env bash
set -euo pipefail

HOST=${JSON.stringify(base)}
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --host)  HOST="$2";  shift 2 ;;
    *) shift ;;
  esac
done

echo "==> Agent Insight 常驻客户端安装"
echo "    host=$HOST"

if [ -z "$TOKEN" ]; then
  echo "缺少安装令牌。请在「客户端安装」页生成完整命令。" >&2
  exit 1
fi

OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  *) echo "本期仅支持 Linux 与 macOS，当前: $OS" >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js（未找到 node）" >&2
  exit 1
fi

PKG_ROOT=""
if [ -f "$(dirname "$0")/../package.json" ]; then
  PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
elif command -v npx >/dev/null 2>&1; then
  echo "==> 通过 npx 安装 agent-insight 客户端"
  npx --yes agent-insight install-ras-client --host "$HOST" --token "$TOKEN"
  exit $?
fi

if [ -z "$PKG_ROOT" ]; then
  echo "未找到 agent-insight 包，且 npx 不可用" >&2
  exit 1
fi

node "$PKG_ROOT/scripts/install-ras-client.js" --host "$HOST" --token "$TOKEN"
`

  return new NextResponse(script, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
