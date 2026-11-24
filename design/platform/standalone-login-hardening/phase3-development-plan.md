# Phase 3：本地账号密码登录开发计划

## 实现步骤

1. `prisma/schema.prisma` 为 `User` 增加 `passwordHash`、`passwordUpdatedAt`、`mustChangePassword`、`disabledAt`。
2. `scripts/init_opengauss.py` 的 `User` 列定义同步补齐；确认 `scripts/db_push.sh` 无需调整白名单。
3. 新增 `src/lib/auth/password.ts`：哈希、校验与策略。
4. 新增 `src/lib/auth/login-rate-limit.ts`：进程内固定窗口限流。
5. 改造 `POST /api/auth/apikey`：standalone 分支要求用户名；存量未设置密码的账号必须出示已有 API Key 或激活凭据；需要改密的账号只返回短时 `passwordSetupToken`，改密后才返回正式 API Key；已设置密码的账号校验密码，缺少密码与密码错误统一 401；禁止自动建号、接入限流。
6. 新增 `GET /api/auth/session` 与 `POST /api/auth/password`（首次设置密码/改密凭据路径可省略当前密码）；新增 `src/lib/auth/password-setup-token.ts` 签发和校验改密用途 token。
7. 新增 `GET/POST /api/admin/accounts`、`DELETE /api/admin/accounts/[username]`（停用）、`POST /api/admin/accounts/batch` 与 `POST /api/admin/accounts/[username]/reset-password`；新建与批量导入生成随机一次性激活凭据，重置由管理员设置新密码。
8. `src/instrumentation-node.ts` 增加启动期 `admin` 用户、`.admin_api_key` 与 `.admin_activation_password` 文件准备；改造 `scripts/sync_admin_api_key.js` 读取该文件并校验 Key 属于当前实例。
9. 不新增独立账号初始化脚本；服务启动已确保 `admin` 存在并写入随机激活凭据。
10. `AuthProvider` 增加 `isAdmin`、`passwordChangeRequired`、`passwordInitialized`，standalone 恢复改走 `/api/auth/session`，并实现强制改密跳转。
11. 登录页支持用户名 + 密码/激活凭据；账号管理页支持新建、批量导入（含 CSV 模版）、重置密码与停用，并使用应用内确认框；改密页区分「设置密码」与「修改密码」，并在使用改密凭据时隐藏当前密码；侧边栏与用户菜单按模式与权限增减入口。
12. 补齐 `src/locales/{zh,en}.ts` 文案。
13. 更新 `.env.example` 与用户/开发者文档。

## 预计文件

- `prisma/schema.prisma`
- `scripts/init_opengauss.py`
- `src/lib/auth/password.ts`（新增）
- `src/lib/auth/login-rate-limit.ts`（新增）
- `src/lib/auth/local-user.ts`
- `src/lib/auth/auth-context.tsx`
- `src/app/api/auth/apikey/route.ts`
- `src/app/api/auth/session/route.ts`（新增）
- `src/app/api/auth/password/route.ts`（新增）
- `src/app/api/admin/accounts/route.ts`（新增）
- `src/app/api/admin/accounts/batch/route.ts`（新增）
- `src/app/api/admin/accounts/[username]/reset-password/route.ts`（新增）
- `src/app/login/page.tsx`
- `src/app/(main)/config/accounts/page.tsx`（新增）
- `src/app/(main)/config/password/page.tsx`（新增）
- `src/components/shell/sidebar-navigation.ts`
- `src/components/shell/AppSidebar.tsx`
- `src/instrumentation-node.ts`
- `scripts/sync_admin_api_key.js`
- `src/locales/zh.ts`、`src/locales/en.ts`
- `.env.example`
- `docs/zh/how-to/platform/settings/access-control.md`
- `docs/zh/tutorial/platform/01-quick-start.md` 及英文对应页

## 测试

新增或改造：

- `test/auth-apikey-registration.test.ts`：由“注册即登录”改为账号登录用例——存量未设置密码仅凭用户名 401、凭已有 Key 只换改密凭据、已设置密码缺密码与密码错误统一 401、改密完成后才返回正式 API Key。
- `test/auth-password-login.test.ts`：哈希往返、策略校验、恒定失败文案、首次登录 `passwordChangeRequired`。
- `test/account-management.test.ts`：非管理员 403、创建与重名 409、随机激活凭据、批量导入创建/跳过、停用账号保留用户名与历史归属、重置直接设置新密码并置 `mustChangePassword`、改密凭据不能访问业务接口、响应不含 `passwordHash`/`apiKey`。
- `test/password-change.test.ts`：当前密码错误、策略不通过、成功后标记清除且 API Key 不变。
- `test/login-rate-limit.test.ts`：阈值、窗口、成功清零、转发头信任开关与键长度截断。
- `test/sync-admin-api-key.test.ts`：改为读取 `.admin_api_key`，覆盖 idaas 与 keyless 跳过分支。
- `test/auth-restore.test.ts`：更新 standalone 恢复链路断言。

关键回归：`test/admin-trace-visibility.test.ts`、IDaaS 登录相关测试必须保持通过（不要求密码）。

## 验证

1. `npx tsc --noEmit`
2. `npm run test`
3. 定向运行上述认证与账号测试。
4. 用含历史用户的旧 SQLite 副本走一次真实启动：确认新列补齐、旧记录保留、再次启动可重复执行、旧 API Key 仍可访问业务接口。
5. 浏览器验证需用户确认后执行 `scripts/develop_start.sh`：
   - 存量未设置密码账号只输入用户名被拒绝，凭已有 API Key 或激活凭据完成设密；
   - `admin` 使用 `.admin_activation_password`（或配置的初始密码）登录后设置密码；
   - 新建账号 → 使用随机激活凭据登录并改密 → 正常进入；
   - 批量导入后使用各自的随机激活凭据登录并改密；
   - 重置密码后旧密码失效、新密码可登录并要求改密，改密前只拿到改密凭据；
   - 停用账号后无法登录、旧 API Key 失效，用户名与历史数据保留，同名账号不能重建；
   - 修改密码后 Agent 上报不中断；
   - `idaas_oauth` 模式登录入口与退出不受影响。

## 上线与回滚

上线：

- 发布说明标注行为变更：存量未设置密码的账号不能只凭用户名登录，需凭已有 API Key 或激活凭据设密；新账号使用随机激活凭据；需要改密的账号改密前只获得改密用途凭据。
- 无需执行管理员初始化：服务启动会确保 `admin` 存在并写入随机激活凭据（或使用 `AGENT_INSIGHT_ADMIN_PASSWORD`）。
- 存量 API Key 不受影响，Agent 上报可继续。

回滚：

- 代码回滚后新增列可以保留，旧版本忽略它们。
- 回滚不会恢复被重置修改的密码；如需保留新账号，回滚前先备份数据库。
