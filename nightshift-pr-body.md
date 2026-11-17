## 问题

OpenCode 斜杠命令会在消息处理阶段展开为长路由提示。采集器虽然通过 `chat.message` 保存了用户原始输入，但 uploader 构造 user interaction 时优先读取展开后的 text part，导致 Trace 列表及下游功能把路由提示首行显示为任务输入。

Closes #264

## 修改

- user interaction 优先采用 `chat.message` 捕获的用户原始文本
- 缺少 hook 原文时继续回退到 text part，兼容旧版 OpenCode 事件
- 新增“长路由提示 + 短斜杠命令”的回归测试
- 补充 OpenCode Trace 输入来源文档

## 历史数据

本修改不会猜测或覆盖已入库记录。可获得原始 OpenCode spool 时，可在升级采集器后定向重新上报受影响 session；无法重建原始输入的记录应仅标记为历史污染，不根据路由提示反推用户命令。

## 验证

- `node --check scripts/opencode_uploader_client.js`
- `node --import tsx --test --test-name-pattern='opencode 上报 payload' test/ingest-payload-contract.test.ts`（2/2 通过）
- `node --import tsx --test test/opencode-uploader-signature.test.ts test/opencode-uploader-grouping.test.ts`（23/23 通过）
- `npm run test` 未启动测试：当前工作区缺少已声明依赖 `gray-matter`，pretest 在生成 benchmark catalog 时失败

未启动 dev server，未在浏览器中验证。
