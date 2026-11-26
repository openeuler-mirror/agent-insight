# Phase 2：本地账号密码登录需求设计

## 模式与范围

- `standalone`：启用密码登录、账号管理与个人改密。
- `organization`、`idaas_oauth`：登录入口与恢复逻辑保持现状；账号管理、改密相关接口返回 404 或 403，页面入口不渲染。
- 两种密码入口都以 `resolveLoginMode()` 为唯一判据，不新增部署开关。

## 数据模型

`User` 新增三列，均可空或带默认值：

```prisma
passwordHash       String?
passwordUpdatedAt  DateTime?
mustChangePassword Boolean @default(false)
disabledAt         DateTime?
```

- 旧行保持 `passwordHash = NULL`，不回填，不阻断启动。
- `passwordHash` 采用自带参数的格式，便于以后调参：
  `scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>`。
- `mustChangePassword` 在管理员新建账号、重置密码时置 `true`，用户完成首次密码设置后置 `false`。
- 新建账号与批量导入写入服务端生成的随机一次性激活凭据，重置密码时由管理员直接指定新密码；两者都置 `mustChangePassword = true`。
- `disabledAt` 标记停用账号；停用保留用户名与历史归属，同时轮换 API Key，查询按 Key 认证时排除已停用账号。
- OpenGauss 初始化脚本 `scripts/init_opengauss.py` 的 `User` 列表同步补列；新增列可空或带默认值，不触发 `scripts/db_push.sh` 的无损白名单。

## 密码处理

新增 `src/lib/auth/password.ts`：

- `hashPassword(plain)`：随机 16 字节盐，`scrypt` 参数 `N=16384, r=8, p=1, keylen=64`，输出上述格式。
- `verifyPassword(plain, stored)`：解析参数后重算，用 `timingSafeEqual` 比较；格式不合法按失败处理。
- `validatePasswordPolicy(plain, username)`：长度 8–128，且不能与用户名相同（忽略大小写）。仅这两条，不做复杂度强制。

密码只在请求内存中短暂存在，不落日志、不进审计字段。

## 登录接口

`POST /api/auth/apikey`（路径保持不变，成功响应新增 `passwordInitialized`）

standalone 请求体：`{ username, password? }`（密码仅对存量未设置密码的账号可省略）

处理顺序：

1. 校验用户名非空，缺失返回 400。
2. 用户名去空白并转小写（与现状一致）。
3. 按用户名查找用户，不创建。
4. 用户不存在：`401 { error: 'Invalid username or password' }`，并记录一次登录失败。
5. 存量账号 `passwordHash` 为空：只凭用户名不再登录成功；出示匹配的 `x-witty-api-key` 时返回
   `{ username, isAdmin, passwordChangeRequired: true, passwordInitialized: false, passwordSetupToken }`，不返回正式 API Key。
6. 已设置密码的账号缺少密码或密码错误：统一返回
   `401 { error: 'Invalid username or password' }`，并计入失败次数，不区分账号是否存在。
7. 通过后，若账号需要改密（`mustChangePassword` 或尚无密码），只返回
   `{ username, isAdmin, passwordChangeRequired: true, passwordInitialized, passwordSetupToken }`；
   否则返回 `{ username, apiKey, isAdmin, passwordChangeRequired: false, passwordInitialized: true }`。
8. `passwordSetupToken` 是短时 HMAC 凭据，只能调用 `POST /api/auth/password`，不能访问业务或管理接口。
9. 响应头 `Cache-Control: no-store`。

`idaas_oauth` 分支保持原逻辑：必须携带 `x-witty-api-key` 并做地区校验，不要求密码。

## 会话恢复

现有 `AuthProvider` 在 standalone 下刷新页面时会重新 `POST /api/auth/apikey` 且不带密码，改造后必然失败。因此新增：

`GET /api/auth/session`

- 从 `x-witty-api-key` 或 `x-witty-password-token` 解析用户。
- 返回 `{ username, isAdmin, passwordChangeRequired, passwordInitialized }`，不返回 API Key。`passwordHash` 为空时 `passwordChangeRequired` 恒为 `true`。
- 两个凭据都无效返回 401；`passwordHash` 为空时仍返回 200（`passwordInitialized: false`），因为该账号正处于首次登录状态。改密凭据只在 `mustChangePassword` 为真时有效。
- 仅 standalone 使用；`organization`、`idaas_oauth` 恢复链路不变。

前端 `AuthProvider`：

- standalone：本地已有 `user_id` 与 `api_key` 时调用 `/api/auth/session` 恢复；401 清除本地凭据。
- 新增 `isAdmin`、`passwordChangeRequired`、`passwordInitialized` 状态，供侧边栏、强制改密和改密页区分「设置密码 / 修改密码」。
- `login()` 保存登录接口返回的两个字段；`logout()` 一并清理。

## 个人改密

`POST /api/auth/password`

- 凭 `x-witty-api-key` 或 `x-witty-password-token` 定位用户；无有效凭据返回 401。
- 请求体 `{ currentPassword?, newPassword }`。
- 账号已有密码时必须校验当前密码（缺失或错误返回 400/401 统一文案）；账号尚无密码或使用改密凭据时跳过该校验。
- 校验新密码策略（不通过返回 400，附具体规则）。
- 成功后更新 `passwordHash`、`passwordUpdatedAt`，`mustChangePassword = false`。
- 不轮换 API Key；使用改密凭据时返回 `{ ok: true, apiKey, isAdmin }`，否则返回 `{ ok: true }`。
- `idaas_oauth` 模式返回 404。

## 账号管理接口

前缀 `/api/admin/accounts`，所有方法先校验有效 API Key 且 `isAdminUser(username)`，否则 403。仅 standalone 生效。

- `GET /api/admin/accounts`
  返回 `[{ username, externalAccount, isAdmin, hasPassword, disabled, disabledAt, createdAt, passwordUpdatedAt }]`，按用户名排序，不返回 `apiKey` 与 `passwordHash`。
- `POST /api/admin/accounts`
  请求 `{ username, password? }`；用户名去空白、转小写，长度上限 128；邮箱形式仅接受 `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`，普通账号仅接受 Unicode 字母/数字与 `._-`，拒绝内部空白、控制字符、`$`、`|`、逗号等。管理员可指定符合策略的密码，未指定时生成随机一次性激活凭据；写入哈希并置 `mustChangePassword = true`，返回 `{ username, adminGranted, initialPassword }`。重名（含已停用账号）返回 409。
  用户名命中管理员白名单且请求未带 `acknowledgeAdmin: true` 时，先返回 `409 { code: 'admin_confirmation_required' }` 且不创建账号；页面二次确认后带该标志重试，避免误建管理员。
- `POST /api/admin/accounts/batch`
  请求 `{ usernames: string[] }`，单次最多 200 个；去空白、转小写、去重后逐个创建，逐个跳过非法、已存在和非确认的管理员账号；创建的账号同样使用随机一次性激活凭据。返回 `{ created: [{ username, initialPassword }], skipped: [{ username, reason }] }`，`reason` 取 `invalid` / `exists` / `admin_confirmation_required`。
- `POST /api/admin/accounts/[username]/reset-password`
  请求 `{ password }`；校验密码策略后写入新密码哈希与 `passwordUpdatedAt`，置 `mustChangePassword = true`，旧密码立即失效，返回 `{ username }`。账号不存在返回 404。
- `DELETE /api/admin/accounts/[username]`
  停用账号：保留账号记录与用户名，写入 `disabledAt` 并轮换 API Key，使登录与旧 Key 立即失效；历史业务数据归属不变，同名账号不能重建。不能停用当前登录账号。账号不存在返回 404，已停用返回 409。

不做修改用户名、手工指定 API Key；批量导入之外不提供其它批量操作。

## 管理员初始化与启动同步

启动同步脚本 `scripts/sync_admin_api_key.js` 目前通过 `POST /api/auth/apikey` 匿名创建 `admin` 并取 Key；密码登录上线后该路径失效。改为：

1. 服务启动时（`src/instrumentation-node.ts`）在 standalone/organization 模式下确保 `admin` 用户存在，并将 Key 写入 `<数据目录>/.admin_api_key`（文件权限 0600）。已存在则复用，不覆盖。
2. 同步脚本不再调用登录接口，改为等待状态接口就绪后读取该文件，并用轻量接口确认 Key 属于当前实例；校验失败不写入 `.env`。校验通过后继续写入 `.env` 的 `AGENT_INSIGHT_HOST` / `AGENT_INSIGHT_API_KEY`。
3. `idaas_oauth` 与 keyless（`AGENT_INSIGHT_DEFAULT_INGEST_USER`）分支维持现有跳过逻辑。

管理员网页登录与 API Key 相互独立。服务启动时已确保 `admin` 存在并设置初始密码，因此首次网页登录无需额外准备：

- `admin` 优先使用 `AGENT_INSIGHT_ADMIN_PASSWORD`；未配置时生成随机一次性激活凭据并写入 `<数据目录>/.admin_activation_password`（0600）。仅当 `passwordHash` 为空或仍是旧版默认 `admin` 口令时写入，首次登录后仍要求改密。
- 不提供独立的账号初始化脚本；其它账号统一由管理员在账号管理页创建、批量导入或停用。
- 已有 API Key 继续有效，Agent 上报不受影响。

`.env.example` 增加 `AGENT_INSIGHT_ADMIN_PASSWORD` 的空值说明。

## 前端

- `/login`：用户名 + 密码两个输入框；提示使用管理员提供的初始密码，不在公开界面展示默认口令。已设置密码的账号缺少密码时显示与密码错误相同的「用户名或密码错误」。
- `/config/accounts`（侧边栏「配置」组，仅 `isAdmin && loginMode === 'standalone'` 可见）：账号列表、新建账号、批量导入（可下载 CSV 模版）、重置密码与删除账号；新建账号初始密码为账号名，重置时管理员直接输入新密码。确认操作统一使用应用内 `ConfirmDialog`，不用浏览器原生确认框。
- `/config/password`：账号尚未设置密码时显示「设置密码」，隐藏当前密码输入；已有密码时显示「修改密码」。
- `AuthProvider`：`passwordChangeRequired` 为真时，除 `/config/password` 外一律重定向到改密页；改密成功后清除标记并标记密码已设置。
- 侧边栏用户菜单增加「修改密码」入口（仅 standalone）。
- `src/locales/{zh,en}.ts` 补齐上述文案。

## 登录限流

新增 `src/lib/auth/login-rate-limit.ts`：

- 键为 `客户端标识 + 小写用户名`（两段均截断到 128 字符），窗口 5 分钟，失败 5 次后返回 `429 { code: 'too_many_attempts', retryAfterSeconds }`。
- 成功登录清零。
- 进程内 Map，带惰性过期清理；多实例之间不共享，作为基础防护而非精确配额。
- 默认不使用客户端可伪造的转发头，所有来源归并到固定桶；仅当 `AGENT_INSIGHT_TRUST_PROXY_HEADERS=true`（可信代理会覆盖 `x-forwarded-for`）时取首段，缺失回退 `x-real-ip`，仍缺失则使用固定桶。

## 兼容与迁移

- 存量账号：`passwordHash = NULL`，升级后不能只凭用户名登录；可凭已保存的 API Key 或管理员重置后的激活凭据完成设密。旧 API Key 继续有效，Agent 上报不受影响。
- 历史用户名大小写：账号查询先精确匹配，未命中再按不区分大小写回退，兼容历史混合大小写记录。
- 升级操作：无需额外初始化；存量未设置密码的账号凭已有 API Key 或管理员重置后的激活凭据完成设密，`admin` 由启动流程写入随机激活凭据。管理员可用账号管理页的重置密码直接为账号设置新密码。
- 前端旧缓存：`AuthProvider` 恢复时会话接口不再拒绝未设置密码的账号，登录状态保持，并按 `passwordChangeRequired` 跳转改密页。
- `POST /api/auth/apikey` 不再对存量未设置密码的账号仅凭用户名登录；已设置密码的账号缺少密码或密码错误统一返回 401。需在发布说明中标注。
- `local-user.ts` 的 `findOrCreateLocalUser` 仍供 IDaaS callback 使用，standalone 登录保持只查不建。

## 失败处理

| 场景 | 行为 |
| - | - |
| 缺少用户名 | 400，指出缺失字段 |
| 存量账号未设置密码且仅提交用户名 | 401，统一凭据错误文案；需出示已有 API Key 或激活凭据 |
| 账号需要改密但凭据正确 | 200，返回 `passwordSetupToken`，不返回正式 API Key |
| 账号已设置密码但缺少密码 | 401，与密码错误、用户不存在同一文案，并计入失败次数 |
| 用户不存在或密码错误 | 401，统一文案 |
| 失败次数超限 | 429 `too_many_attempts` |
| 非管理员访问账号接口 | 403 |
| 批量导入超过 200 个或 `usernames` 非数组 | 400 |
| 非 standalone 访问密码接口 | 404 |
| 数据目录不可写导致 Key 文件写入失败 | 启动日志告警，不阻塞服务；同步脚本报错退出 |

## 安全边界

- `passwordHash` 与 `apiKey` 都不出现在账号列表响应和日志中。
- 初始激活凭据由服务端随机生成，或由管理员显式设置；只在创建/重置响应中回显一次，存储的始终是哈希。
- 改密前的登录凭据是短时 HMAC token，只能调用改密接口；不能当业务 API Key 或管理员凭据使用。已有 API Key 在改密前仍可用于 Agent 上报，但浏览器不能凭它绕过改密。
- 存量未设置密码的账号必须凭已有 API Key 或管理员下发的激活凭据设密，不能再被知道用户名的人抢先占用。
- 登录失败不区分缺少密码、密码错误与用户不存在。
- 管理员接口以 API Key 解析出的用户名判定，不信任请求体中的身份。
- 账号管理页面对命中管理员白名单的用户名做显著提示，避免误建管理员；批量导入默认跳过管理员账号。
- 本次不改变 API Key 明文存储，相关风险在后续需求单独处理。
