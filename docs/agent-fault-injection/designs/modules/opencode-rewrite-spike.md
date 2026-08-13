# OpenCode rewrite 消镜像 — Spike 结论（V2）

## 候选对比

| 候选 | 结论 |
|------|------|
| **A. 表驱动同源** | **采纳**：Python `rewrite_engine` 为语义 SoT；OpenCode 侧 `rewrite-runtime.ts` 用 op→handler 表驱动，无散落 if-chain；`capability_api.yaml` + `test_rewrite_parity_fixtures.py` 锁 ops |
| B. 子进程调 Python | **不采纳（热路径）**：每个 middleware hook 启进程延迟与失败面不可接受 |
| C. 双运行时仅对拍 | 作为过渡底线已部分覆盖；A 落地后仍保留 Python 侧 fixture 门禁 |

## 交付

1. [`rewrite-runtime.ts`](../../../../agent_fault_injection/platform_adapters/opencode/lib/rewrite-runtime.ts) — 薄表驱动实现（隔离环境拷到 workspace `.opencode/lib/`，勿放进 `plugins/`）  
2. [`provider-tool-call-rewrite.ts`](../../../../agent_fault_injection/platform_adapters/opencode/lib/provider-tool-call-rewrite.ts) — provider 工具调用改写辅助（与上项同目录安装）  
3. [`agent-fault-injection.ts`](../../../../agent_fault_injection/platform_adapters/opencode/plugin/agent-fault-injection.ts) — 只接线 hook，改写委托 rewrite-runtime / provider-tool-call-rewrite  
4. Adapter 拷贝入口插件 + `lib/{rewrite-runtime,provider-tool-call-rewrite}.ts`，并在缺失时预置 workspace `.opencode/package.json`（`@opencode-ai/plugin`）；不整目录扫 `plugin/*.ts`，避免遗留模块被当成插件  
5. [`test_rewrite_parity_fixtures.py`](../../../../agent_fault_injection/tests/unit/test_rewrite_parity_fixtures.py) — Python runtime op 与 capability 清单对拍（TS handlers 真执行对拍另开）  

## 门禁

- 新增 runtime op：先改 `capability_api.yaml` + Python `rewrite_engine` + fixture 测试；再在 `rewrite-runtime.ts` handlers 表加一项（禁止在主插件文件写业务分支）。
