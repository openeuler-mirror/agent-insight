export async function register() {
  // Server-side watchers have been removed.
  // Watchers now run on the client side via scripts downloaded through curl setup.
  // See: scripts/claude_watcher_client.ts and scripts/openclaw_watcher_client.ts

  // 仅在 nodejs runtime 起来的时候做 instrumentation——edge 没 prisma / child_process
  // 等 Node API。所有真正的启动逻辑都在 ./instrumentation-node.ts 里，这里只做 runtime
  // 路由。这样 Next.js 的 Edge 静态分析器看到的只是个 dynamic import 字符串，不会去扫
  // node:fs / node:child_process 这些 import 然后给你刷一屏 warning。
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { setupNodeRuntime } = await import('./instrumentation-node');
    await setupNodeRuntime();
  }
}
