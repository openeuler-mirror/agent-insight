# Phase 3：IDaaS OAuth 登录开发计划

## 实现步骤

1. 新增登录模式解析与 IDaaS OAuth 配置校验模块。
2. 抽取并发安全的本地用户查找/注册服务，供本地登录和 IDaaS callback 复用。
3. 新增 authorize、callback、complete 三个 API 路由。
4. 配置状态接口增加 `login_mode`，保留历史 `org_mode` 契约。
5. IDaaS 模式收紧 `POST /api/auth/apikey`，只允许使用已有 API Key 恢复登录态。
6. AuthContext 增加模式状态，登录页接入跳转和 complete，侧边栏沿用通用退出入口。
7. 增加中英文登录文案。
8. 增加模式解析、签名 Cookie、OAuth URL/响应、接口绕过保护和 UI 静态契约测试。
9. 更新用户指南和开发者指南。
10. 启动同步先读取登录模式；IDaaS 模式跳过 admin Key 创建并保留已有客户端 Key。
11. IDaaS 路由向浏览器保留通用错误，同时在服务端日志记录不含配置值的具体异常原因。
12. 新增 `/callback` 回调入口，并保留原 IDaaS callback 路径兼容。

## 预计文件

- `src/lib/auth/login-mode.ts`
- `src/lib/auth/idaas-oauth.ts`
- `src/lib/auth/local-user.ts`
- `src/app/api/auth/idaas-oauth/{authorize,callback,complete}/route.ts`
- `src/app/callback/route.ts`
- `src/app/api/auth/apikey/route.ts`
- `src/app/api/eval/config/status/route.ts`
- `src/lib/auth/auth-context.tsx`
- `src/app/login/page.tsx`
- `src/components/shell/AppSidebar.tsx`
- `src/locales/{zh,en}.ts`
- `scripts/sync_admin_api_key.js`
- `test/idaas-oauth-login.test.ts`
- `test/sync-admin-api-key.test.ts`
- 认证相关用户/开发者指南

## 验证

1. `npx tsc --noEmit`
2. `TMPDIR=/tmp npm run test`
3. 定向运行 IDaaS OAuth 与本地登录注册测试。
4. 检查提交差异不含专有服务名称、真实 endpoint、client ID、client secret 或用户数据。
5. 浏览器验证需用户确认后使用 `scripts/develop_start.sh`：
   - 本地模式邮箱登录及退出。
   - IDaaS 模式按钮、授权跳转、callback 和 UUID 首次注册。
   - IDaaS 模式退出后清除本地状态，再次登录仍经过统一身份授权。
   - 错误 state 和冲突配置。

## 回滚

- 将 `LOGIN_MODE` 设回 `standalone` 即恢复默认本地登录。
- 历史组织部署继续只设置 `ORGANIZATION_MODE=true`。
- 删除新增 IDaaS 路由和模式分支即可回滚代码；无数据库迁移。
