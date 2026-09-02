# Phase 2：IDaaS OAuth 登录需求设计

## 配置模型

`resolveLoginMode()` 返回：

- `standalone`：默认本地邮箱登录。
- `organization`：历史组织集成，仅由 `ORGANIZATION_MODE=true` 得出。
- `idaas_oauth`：新统一身份登录。

解析顺序：

1. `LOGIN_MODE=idaas_oauth` 与 `ORGANIZATION_MODE=true` 同时出现时返回配置错误。
2. `ORGANIZATION_MODE=true` 时返回 `organization`，保持存量兼容。
3. `LOGIN_MODE` 未设置或为 `standalone` 时返回 `standalone`。
4. `LOGIN_MODE=idaas_oauth` 时校验全部 `IDAAS_OAUTH_*` 配置。
5. 未知值返回配置错误，不降级。

IDaaS OAuth 必填变量：

- `IDAAS_OAUTH_AUTHORIZATION_URL`
- `IDAAS_OAUTH_TOKEN_URL`
- `IDAAS_OAUTH_USERINFO_URL`
- `IDAAS_OAUTH_CLIENT_ID`
- `IDAAS_OAUTH_CLIENT_SECRET`
- `IDAAS_OAUTH_REDIRECT_URI`
- `IDAAS_OAUTH_SCOPE`

`IDAAS_OAUTH_REDIRECT_URI` 推荐使用部署地址下的 `/callback`；继续兼容原 `/api/auth/idaas-oauth/callback`。配置值、authorization 请求和 token 请求必须保持完全一致。

IDaaS 地区访问限制默认关闭；启用时还需配置 `IDAAS_REGION_ACCESS_ENABLED=true`、IAM/人员服务 URL、IAM project/account/secret/enterprise 和 `IDAAS_REGION_ACCESS_TLS_VERIFY`。`.env.example` 对每项给出用途说明，真实地址、凭据和租户标识不得提交。TLS 开关默认 `false`，仅作用于地区 IAM/人员请求的专用 `undici.Agent`。

## 服务端流程

### authorize

`GET /api/auth/idaas-oauth/authorize`

1. 校验当前模式和 OAuth 配置。
2. 校验可选 `returnTo` 只能是站内路径。
3. 生成随机 state，将 state、returnTo、过期时间放入 HMAC-SHA256 签名的 HttpOnly Cookie。
4. 302 跳转 authorization endpoint，携带 `client_id`、`response_type=code`、`redirect_uri`、`scope`、`state`。

### callback

`GET /callback`（推荐）或 `GET /api/auth/idaas-oauth/callback`（兼容）

1. 拒绝 IDaaS 返回的 error、缺少 code/state、无效或过期 state Cookie。
2. token endpoint 按既有接入约定以 POST + query 参数接收授权码、client ID、client secret、redirect URI。
3. userinfo endpoint 按既有接入约定以 POST + query 参数接收 scope、client ID、access token。
4. 读取并校验非空 UUID，去除首尾空白后保持原值。
5. 地区限制开启时，以 `{ uuids: [uuid] }` 查询人员信息；直接常驻地、组织树或主管常驻地命中欧盟时拒绝。
6. 地区查询异常、空数据或关键字段缺失时失败关闭，拒绝本次登录。
7. 仅在地区检查放行后，按 UUID 查找或并发安全地创建本地 User，新用户复用现有示例初始化。
8. 生成只包含 username、nonce、过期时间的签名登录结果 Cookie，清除 state Cookie。
9. 跳回 `/login?idaas=complete`，保留已验证的 returnTo。

### complete

`POST /api/auth/idaas-oauth/complete`

1. 校验模式及签名登录结果 Cookie。
2. 按 Cookie 中 username 重新读取 User。
3. 返回现有 AuthContext 所需的 `username`、`apiKey`，并清除结果 Cookie。

签名密钥从 client secret 通过带固定用途标签的 SHA-256 派生，避免直接混用原始字节。Cookie 均为 HttpOnly、SameSite=Lax；redirect URI 为 HTTPS 时加 Secure。

## 前端流程

- `AuthProvider` 统一读取 `login_mode`，向下暴露 `loginMode` 和 `loginModeReady`。
- 本地模式继续调用 `POST /api/auth/apikey`。
- 历史组织模式继续调用 `GET /api/auth/organization`。
- IDaaS 模式首次登录跳转 authorize；callback 返回后由登录页 POST complete，再复用现有 `login()`。
- IDaaS 模式恢复本地状态时，`POST /api/auth/apikey` 必须携带已保存 API Key，并以去除首尾空白但保持大小写的 UUID 精确匹配已有用户；standalone 邮箱仍转为小写。服务端先验证现有用户，再执行同一地区检查；受限返回 403，校验不可用返回 503，均不允许恢复或签发 Key。
- `AppSidebar` 在所有登录模式下渲染通用退出菜单；退出清除 `localStorage` 中的 username/API Key 并返回登录页，不吊销 API Key，也不调用 IDaaS logout endpoint。

## 启动同步

- `scripts/sync_admin_api_key.js` 先请求 `GET /api/eval/config/status?check_login=true`；接口成功同时作为开发启动脚本的服务就绪判据。
- `idaas_oauth` 模式不请求 `POST /api/auth/apikey` 创建 admin，而是更新 `AGENT_INSIGHT_HOST` 后正常结束启动等待。
- 已有 `AGENT_INSIGHT_API_KEY` 原样保留；不存在时保持为空，用户首次 IDaaS 登录后再从安装指导取得个人 Key。
- standalone 与历史 organization 模式继续沿用原 admin Key 初始化行为。

## 失败处理

- 配置错误：状态接口和 IDaaS API 返回 500，登录页展示通用配置错误；服务端日志记录缺失或无效的变量名等具体原因，但不记录变量值、client secret 或请求 URL；不得回落到本地登录。
- 模式不匹配：IDaaS API 返回 404。
- state/code/userinfo 错误：callback 返回登录页的固定错误码，不透传上游正文。
- OAuth 上游超时或非 2xx：固定登录失败，不记录敏感请求 URL。
- 地区明确受限：使用 `region_restricted`，登录页显示“您的地区暂无法使用”。
- 地区 IAM/人员接口异常、空数据或关键字段缺失：使用 `region_check_unavailable`，登录页显示“地区信息校验失败，请稍后重试”；异常结果不缓存。
- complete Cookie 无效或过期：401，并清除 Cookie。

## 数据模型

不新增表。User 仍以 `username` 唯一；IDaaS UUID 去除首尾空白后直接作为 username。登录衔接使用短时签名 Cookie，不保存 OAuth token。地区 IAM token 在进程内缓存 10 小时，UUID 和主管人员记录缓存 2 小时，重启清空且多实例之间不共享。

## 安全边界

- `client_secret` 仅服务端读取，变量不使用 `NEXT_PUBLIC_`。
- API Key 不进入 callback URL。
- 配置状态接口只返回模式，不返回 OAuth endpoints、client ID 或 scope。
- IDaaS 模式关闭本地邮箱自注册入口，防止绕过统一身份认证。
