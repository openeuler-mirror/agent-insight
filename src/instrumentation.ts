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

export async function register() {
  // Server-side watchers have been removed.
  // Claude Code now uses official OTel logs configured by setup; OpenClaw still uses
  // the client-side watcher script downloaded through curl setup.
  // See: scripts/openclaw_watcher_client.ts

  // 仅在 nodejs runtime 起来的时候做 instrumentation——edge 没 prisma / child_process
  // 等 Node API。所有真正的启动逻辑都在 ./instrumentation-node.ts 里，这里只做 runtime
  // 路由。这样 Next.js 的 Edge 静态分析器看到的只是个 dynamic import 字符串，不会去扫
  // node:fs / node:child_process 这些 import 然后给你刷一屏 warning。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installServerLogging } = await import('./lib/logger/server');
    installServerLogging();
    const { setupNodeRuntime } = await import('./instrumentation-node');
    await setupNodeRuntime();
    void import('./lib/runtime-cleanup')
      .then(({ startRuntimeCleanup }) => { startRuntimeCleanup(); })
      .catch(() => { console.warn('[instrumentation] runtime cleanup registration failed'); });
  }
}
