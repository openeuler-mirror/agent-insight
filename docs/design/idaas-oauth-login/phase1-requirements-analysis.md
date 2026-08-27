# Phase 1：IDaaS OAuth 登录需求分析

## 背景

平台已有两种与账号相关的路径：

- 默认本地登录：用户输入邮箱，平台按邮箱查找或注册本地用户并签发 API Key。
- 历史组织集成：由 `ORGANIZATION_MODE` 与 `ORG_*` 控制，依赖上游网关 Cookie 获取组织用户，并联动组织 Skill 接口。

本需求新增第三种部署级登录选择：应用作为 OAuth 2.0 客户端，通过 IDaaS 授权码流程取得用户 UUID，再复用本地用户和 API Key 数据隔离机制。

## 术语边界

| 名称 | 配置 | 职责 |
| --- | --- | --- |
| 本地登录 | `LOGIN_MODE=standalone` | 用户自行输入邮箱，登录即注册 |
| 历史组织集成 | `ORGANIZATION_MODE=true`、`ORG_*` | 网关 Cookie 用户信息及组织 Skill 联动 |
| IDaaS OAuth 登录 | `LOGIN_MODE=idaas_oauth`、`IDAAS_OAUTH_*` | OAuth 授权码登录，不调用组织接口 |

代码、API、Cookie 和环境变量必须保持上述边界，不使用笼统的“企业模式”代指后两者。

## 功能需求

1. 不配置 `LOGIN_MODE` 时保持现有行为；`ORGANIZATION_MODE=true` 的存量部署继续进入历史组织集成。
2. `LOGIN_MODE=idaas_oauth` 时，登录页只提供“统一身份登录”入口。
3. IDaaS 登录使用 authorization code、client ID、client secret、redirect URI 和 scope。
4. callback 校验随机 `state`，使用相同 redirect URI 换取 access token，并通过 userinfo 取得 `uuid`。
5. IDaaS UUID 全局唯一；本地 `User.username` 直接使用去除首尾空白后的 UUID。不存在时自动注册并注入现有新用户示例。
6. IDaaS access token 只用于本次 userinfo 请求，不持久化、不返回浏览器。
7. callback 通过短时签名 HttpOnly Cookie 把登录结果交给登录页，浏览器 URL 不携带 API Key、UUID 或 userinfo。
8. IDaaS OAuth 登录模式保留通用退出入口；退出只清除当前浏览器的本地账号和 API Key，不执行 IDaaS 单点登出。
9. IDaaS OAuth 登录与历史组织集成不支持同时开启，冲突配置必须失败关闭，不能降级到本地登录。

## 非功能需求

- 公共代码中不出现部署方品牌、内部域名、真实 client ID/secret、scope 或用户样本。
- 新代码使用 `idaas-oauth`、`IdaasOAuth*`、`IDAAS_OAUTH_*` 通用命名。
- 兼容 `NEXT_PUBLIC_URL_PREFIX`。
- authorization、callback、complete 响应禁止缓存。
- OAuth 网络请求设置固定超时，错误响应不泄露 token、secret 或原始 userinfo。
- 保持 SQLite/OpenGauss 双数据库行为；本期不新增数据库表。

## 非目标

- PKCE、OIDC discovery、多提供商、角色/部门同步。
- refresh token、token refresh、token revoke、统一单点登出。
- 改造历史组织接口或组织 Skill 行为。
- 改造全站 API Key 数据归属机制。

## 验收标准

- 三种部署配置得到明确且互不混淆的登录模式。
- IDaaS OAuth 完成授权、callback、UUID 注册和页面登录。
- redirect URI 前后一致，错误 state 或缺少 UUID 时登录失败。
- IDaaS 模式不能通过本地邮箱接口绕过 OAuth。
- 三种模式都显示退出按钮；IDaaS 退出后再次登录仍经过统一身份授权。
- 源码与提交差异中不含专有服务名称和真实配置。
