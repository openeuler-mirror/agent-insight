# DeepSeek Harness 观测插件无 ZIP 安装设计

## 背景

DeepSeek Harness 观测插件只有 `package.json`、`index.js` 和 `cordis.patch.yml` 三个小文件。当前专用安装器先下载 ZIP Bundle，再依赖客户端 `unzip` 解压。这个归档层没有带来足够收益，却增加了安装前置条件。

## 范围

本轮只移除 DeepSeek Harness 观测插件的 ZIP 下发与 `unzip` 依赖：

- 保持平台生成的一键 `curl | bash` 入口不变；
- 保持三个插件文件及其 DSH 装配关系不变；
- 保持 `headless`、`web` 两个 profile 的注册逻辑不变；
- 保持 Agent Insight 地址和 API Key 的持久化方式不变；
- 暂不调整现有 DSH 检测或安装逻辑；
- 不影响 Codex、Pi Agent、LlamaIndex 等其他框架的归档下发方式。

## 方案

服务端维护三个文件的显式白名单，并为每个文件计算 SHA-256。专用安装器响应中注入安装版本摘要和三个文件的期望摘要。客户端依次从白名单资源接口下载：

1. `package.json`
2. `index.js`
3. `cordis.patch.yml`

所有文件先写入 `mktemp` 创建的临时目录。安装器逐一校验 SHA-256，并确认三个文件完整后，才复制到 `~/.agent-insight/deepseek-harness/<source-digest>/`，随后调用 `dsh plugin add` 注册两个 profile。

资源接口只接受三个固定文件名，不允许路径片段、任意相对路径或符号链接。响应使用与文件类型对应的 Content-Type、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff` 和 `X-Agent-Insight-SHA256`。

旧的 ZIP Bundle 路由与 ZIP 构造逻辑随本次变更删除。历史安装目录不主动清理，已安装 profile 会在重新执行 curl 后指向新的源摘要目录。

## 失败处理

- 任一下载失败：安装器退出，不调用 `dsh plugin add`；
- 任一摘要不匹配：安装器退出，不激活临时文件；
- 文件不完整：安装器退出并由 trap 清理临时目录；
- 服务端部署在三次下载之间发生切换：摘要不一致时安全失败，用户重跑即可；
- 重复安装相同内容：继续复用相同 source digest，行为保持幂等。

## 验证

- 单元测试验证白名单文件、内容、逐文件摘要和组合摘要；
- 路由测试验证三个合法文件返回 200、未知文件返回 404；
- 安装器测试验证不再出现 `.zip`、`unzip` 或 Bundle 路由；
- 统一 curl 与自动安装两条入口继续委托专用安装器；
- Bash 语法检查通过；
- 在隔离 HOME/DSH_HOME 中执行真实安装，确认三个文件落盘、两个 profile 可 dump config；
- 使用新安装结果运行一次 DSH，确认 Agent Insight 可生成真实 Trace。
