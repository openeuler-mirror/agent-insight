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
```

- 旧行保持 `passwordHash = NULL`，不回填，不阻断启动。
- `passwordHash` 采用自带参数的格式，便于以后调参：
  `scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>`。
- `mustChangePassword` 在管理员新建账号、重置密码时置 `true`，用户完成首次密码设置后置 `false`。
- 新建账号与重置密码都不生成密码，`passwordHash` 保持为空，账号处于「首次登录免密」状态。
- OpenGauss 初始化脚本 `scripts/init_opengauss.py` 的 `User` 列表同步补列；新增列可空或带默认值，不触发 `scripts/db_push.sh` 的无损白名单。

## 密码处理

新增 `src/lib/auth/password.ts`：

- `hashPassword(plain)`：随机 16 字节盐，`scrypt` 参数 `N=16384, r=8, p=1, keylen=64`，输出上述格式。
- `verifyPassword(plain, stored)`：解析参数后重算，用 `timingSafeEqual` 比较；格式不合法按失败处理。
- `validatePasswordPolicy(plain, username)`：长度 8–128，且不能与用户名相同（忽略大小写）。仅这两条，不做复杂度强制。

密码只在请求内存中短暂存在，不落日志、不进审计字段。

## 登录接口

`POST /api/auth/apikey`（路径保持不变，成功响应新增 `passwordInitialized`）

standalone 请求体：`{ username, password? }`

处理顺序：

1. 校验用户名非空，缺失返回 400；密码可省略。
2. 用户名去空白并转小写（与现状一致）。
3. 按用户名查找用户，不创建。
4. 用户不存在：`401 { error: 'Invalid username or password' }`。
5. 用户存在但 `passwordHash` 为空：只凭用户名登录成功，返回
   `{ username, apiKey, isAdmin, passwordChangeRequired: true, passwordInitialized: false }`。
6. 用户已设置密码但未提交密码：`400 { code: 'password_required' }`；密码错误：
   `401 { error: 'Invalid username or password' }`。
7. 通过后返回 `{ username, apiKey, isAdmin, passwordChangeRequired, passwordInitialized: true }`。
8. 响应头 `Cache-Control: no-store`。

`idaas_oauth` 分支保持原逻辑：必须携带 `x-witty-api-key` 并做地区校验，不要求密码。

## 会话恢复

现有 `AuthProvider` 在 standalone 下刷新页面时会重新 `POST /api/auth/apikey` 且不带密码，改造后必然失败。因此新增：

`GET /api/auth/session`

- 从 `x-witty-api-key` 解析用户（复用 `resolveUser`）。
- 返回 `{ username, isAdmin, passwordChangeRequired, passwordInitialized }`，不返回 API Key。`passwordHash` 为空时 `passwordChangeRequired` 恒为 `true`。
- API Key 无效返回 401；`passwordHash` 为空时仍返回 200（`passwordInitialized: false`），因为该账号正处于首次登录状态。
- 仅 standalone 使用；`organization`、`idaas_oauth` 恢复链路不变。

前端 `AuthProvider`：

- standalone：本地已有 `user_id` 与 `api_key` 时调用 `/api/auth/session` 恢复；401 清除本地凭据。
- 新增 `isAdmin`、`passwordChangeRequired`、`passwordInitialized` 状态，供侧边栏、强制改密和改密页区分「设置密码 / 修改密码」。
- `login()` 保存登录接口返回的两个字段；`logout()` 一并清理。

## 个人改密

`POST /api/auth/password`

- 凭 `x-witty-api-key` 定位用户；无有效凭据返回 401。
- 请求体 `{ currentPassword?, newPassword }`。
- 账号已有密码时必须校验当前密码（缺失或错误返回 400/401 统一文案）；账号尚无密码时跳过该校验，用于首次登录设置密码。
- 校验新密码策略（不通过返回 400，附具体规则）。
- 成功后更新 `passwordHash`、`passwordUpdatedAt`，`mustChangePassword = false`。
- 不轮换 API Key，不上线新会话；返回 `{ ok: true }`。
- `idaas_oauth` 模式返回 404。

## 账号管理接口

前缀 `/api/admin/accounts`，所有方法先校验有效 API Key 且 `isAdminUser(username)`，否则 403。仅 standalone 生效。

- `GET /api/admin/accounts`
  返回 `[{ username, externalAccount, isAdmin, hasPassword, createdAt, passwordUpdatedAt }]`，按用户名排序，不返回 `apiKey` 与 `passwordHash`。
- `POST /api/admin/accounts`
  请求 `{ username }`；用户名去空白、转小写，长度上限 128，含 `@` 时沿用现有邮箱格式校验。创建不含密码的用户（`passwordHash` 为空、`mustChangePassword = true`），返回 `{ username, adminGranted }`。重名返回 409。
  用户名命中管理员白名单且请求未带 `acknowledgeAdmin: true` 时，先返回 `409 { code: 'admin_confirmation_required' }` 且不创建账号；页面二次确认后带该标志重试，避免误建管理员。
- `POST /api/admin/accounts/batch`
  请求 `{ usernames: string[] }`，单次最多 200 个；去空白、转小写、去重后逐个创建，逐个跳过非法、已存在和非确认的管理员账号。返回 `{ created, skipped: [{ username, reason }] }`，`reason` 取 `invalid` / `exists` / `admin_confirmation_required`。
- `POST /api/admin/accounts/[username]/reset-password`
  清空 `passwordHash`、`passwordUpdatedAt`，置 `mustChangePassword = true`，账号回到免密首次登录状态，返回 `{ username }`。账号不存在返回 404。

不做删除、禁用、修改用户名、手工指定 API Key。

## 管理员初始化与启动同步

启动同步脚本 `scripts/sync_admin_api_key.js` 目前通过 `POST /api/auth/apikey` 匿名创建 `admin` 并取 Key；密码登录上线后该路径失效。改为：

1. 服务启动时（`src/instrumentation-node.ts`）在 standalone/organization 模式下确保 `admin` 用户存在，并将 Key 写入 `<数据目录>/.admin_api_key`（文件权限 0600）。已存在则复用，不覆盖。
2. 同步脚本不再调用登录接口，改为等待状态接口就绪后读取该文件，继续写入 `.env` 的 `AGENT_INSIGHT_HOST` / `AGENT_INSIGHT_API_KEY`。
3. `idaas_oauth` 与 keyless（`AGENT_INSIGHT_DEFAULT_INGEST_USER`）分支维持现有跳过逻辑。

管理员网页登录与 API Key 相互独立。服务启动时已确保 `admin` 存在，因此首次网页登录无需额外准备：

- `admin` 默认没有密码，首次登录免密，登录后立即要求设置密码。
- 执行 `node --import tsx scripts/init-admin-account.ts [username]` 仅用于确保指定账号存在；账号存在时不改动其密码状态。
- 首次启动时如设置可选环境变量 `AGENT_INSIGHT_ADMIN_PASSWORD`，仅在目标账号 `passwordHash` 为空时写入；写入后该变量不再生效，登录后仍会要求改密。

不执行上述任一步时，`admin` 也可以直接网页登录并设置密码；已有 API Key 继续有效（Agent 上报不受影响）。

`.env.example` 增加 `AGENT_INSIGHT_ADMIN_PASSWORD` 的空值说明。

## 前端

- `/login`：用户名 + 密码两个输入框，密码可留空；提示「首次登录或密码已被重置时无需输入密码」。已设置密码的账号未填密码时显示「该账号已设置密码，请输入密码」。
- `/config/accounts`（侧边栏「配置」组，仅 `isAdmin && loginMode === 'standalone'` 可见）：账号列表、新建账号、批量导入、重置密码；新建与重置都只提示状态，不再展示初始密码。确认操作统一使用应用内 `ConfirmDialog`，不用浏览器原生确认框。
- `/config/password`：账号尚未设置密码时显示「设置密码」，隐藏当前密码输入；已有密码时显示「修改密码」。
- `AuthProvider`：`passwordChangeRequired` 为真时，除 `/config/password` 外一律重定向到改密页；改密成功后清除标记并标记密码已设置。
- 侧边栏用户菜单增加「修改密码」入口（仅 standalone）。
- `src/locales/{zh,en}.ts` 补齐上述文案。

## 登录限流

新增 `src/lib/auth/login-rate-limit.ts`：

- 键为 `IP + 小写用户名`，窗口 5 分钟，失败 5 次后返回 `429 { code: 'too_many_attempts', retryAfterSeconds }`。
- 成功登录清零。
- 进程内 Map，带惰性过期清理；多实例之间不共享，作为基础防护而非精确配额。
- IP 取 `x-forwarded-for` 首段，缺失时回退固定字符串；不因代理差异放宽阈值。

## 兼容与迁移

- 存量账号：`passwordHash = NULL`，升级后可直接网页登录并设置密码；旧 API Key 继续有效，Agent 上报与已登录浏览器不受影响。
- 升级操作：无需额外初始化；`admin` 与存量账号都能免密首次登录后设置密码。管理员也可继续用账号管理页的重置密码清空某个账号的密码。
- 前端旧缓存：`AuthProvider` 恢复时会话接口不再拒绝未设置密码的账号，登录状态保持，并按 `passwordChangeRequired` 跳转改密页。
- `POST /api/auth/apikey` 对缺少密码的新建账号不再返回 400，而是直接登录并强制设置密码；已设置密码的账号仍要求密码。需在发布说明中标注。
- `local-user.ts` 的 `findOrCreateLocalUser` 仍供 IDaaS callback 使用，standalone 登录保持只查不建。

## 失败处理

| 场景 | 行为 |
| - | - |
| 缺少用户名 | 400，指出缺失字段 |
| 账号未设置密码但缺少密码 | 200，免密登录并返回 `passwordInitialized: false` |
| 账号已设置密码但缺少密码 | 400 `password_required` |
| 用户不存在或密码错误 | 401，统一文案 |
| 失败次数超限 | 429 `too_many_attempts` |
| 非管理员访问账号接口 | 403 |
| 批量导入超过 200 个或 `usernames` 非数组 | 400 |
| 非 standalone 访问密码接口 | 404 |
| 数据目录不可写导致 Key 文件写入失败 | 启动日志告警，不阻塞服务；同步脚本报错退出 |

## 安全边界

- `passwordHash` 与 `apiKey` 都不出现在账号列表响应和日志中。
- 不再生成或传输初始密码；新建与重置账号只留下「未设置密码」状态。
- 未设置密码的账号可被知道用户名的人抢先完成首次登录并设置密码，这是首次免密登录的固有代价；账号只能由管理员创建或批量导入，不开放自助注册。
- 登录失败不区分密码错误与用户不存在（账号尚未设置密码时按免密规则处理）。
- 管理员接口以 API Key 解析出的用户名判定，不信任请求体中的身份。
- 账号管理页面对命中管理员白名单的用户名做显著提示，避免误建管理员；批量导入默认跳过管理员账号。
- 本次不改变 API Key 明文存储，相关风险在后续需求单独处理。
