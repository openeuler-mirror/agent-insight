# agent-insight 发布指南（团队维护者版）

> 本文给被授权的维护者，说明如何把 `agent-insight` 打包并发布到 npm。
> 一条命令即可：**`node scripts/publish-npm.js --version <版本> --tag latest`**

---

## 0. TL;DR（已配好 token 的老手）

```bash
# 在项目根目录
node scripts/publish-npm.js --version 0.1.0-beta --tag latest
```

脚本会自动：升版本号 → `npm ci` → `npm run build` → 组装/裁剪 standalone → `npm pack` → 校验 npm 认证 → 发布到官方源。

发布前想先验证不真发，加 `--dry-run`（见 §4）。

---

## 1. 谁能发布

发布权限由 npm 的「包 owner 列表」控制（`agent-insight` 是不带 scope 的包）。

- 现有 owner 把你加进来：`npm owner add <你的npm用户名> agent-insight`
- 查看当前 owner：`npm owner ls agent-insight`
- 移除：`npm owner rm <用户名> agent-insight`

> 注意：不带 scope 的包，所有 owner 权限平等，任何 owner 都能加/踢别人。仅限可信团队。

---

## 2. 新维护者一次性配置（4 步）

1. **被加成 owner**（让现有 owner 执行 `npm owner add <你> agent-insight`）
2. **注册 npm 账号**（如果还没有）：<https://www.npmjs.com/signup>
3. **生成 Automation token**（会绕过 2FA，适合脚本发布）：
   npmjs.com → 右上头像 → **Access Tokens** → **Generate New Token** → **Classic Token** → 选 **Automation** → Generate → 复制（`npm_` 开头）
4. **写进你的 `~/.npmrc`**（**绝不要提交到仓库**）：
   ```bash
   echo "//registry.npmjs.org/:_authToken=npm_你的token" >> ~/.npmrc
   ```
   验证：
   ```bash
   npm whoami --registry https://registry.npmjs.org/   # 打印你的用户名即 OK
   ```

> 这行 token 是「针对 npmjs.org 官方源的认证」，**不会影响**你默认的国内镜像（平时装包照样快）。

---

## 3. 发布命令与参数

```bash
node scripts/publish-npm.js [options]
```

| 参数 | 说明 |
|---|---|
| `--version <版本>` | 指定确切版本，如 `0.1.0-beta`、`1.0.0` |
| `--type patch\|minor\|major` | 自动递增版本（与 `--version` 二选一） |
| `--prerelease alpha\|beta\|rc` | 配合 `--type` 加预发布后缀 |
| `--tag <tag>` | npm dist-tag，默认 `latest` |
| `--dry-run` | 只打包不发布（强烈建议先跑） |

### 版本号约定

- 我们的版本号带 `-beta` 后缀（如 `0.1.0-beta`），但**仍发到 `latest`**，因为它就是对外的当前版本。
- ✅ 正确：`--version 0.1.0-beta --tag latest`
- ⚠️ 迭代时**往上加版本号**（npm 版本不可变，不能覆盖）：
  `0.1.0-beta → 0.1.1-beta → 0.2.0-beta ...`
- 如果只是内部灰度、不想动 `latest`，才用 `--tag beta`（用户需 `npx agent-insight@beta` 才能拿到）。

---

## 4. 发布前先 dry-run（推荐）

```bash
node scripts/publish-npm.js --version 0.1.0-beta --dry-run
```

会完整 build + 打包但**不上传**，产出 `agent-insight-<版本>.tgz`。检查：

```bash
# 看体积（正常约 30~35MB）
ls -lh agent-insight-*.tgz

# 确认本地/临时目录没被打进去（应都为 0）
tar -tzf agent-insight-*.tgz | grep -c 'standalone/exclude/'
tar -tzf agent-insight-*.tgz | grep -c 'standalone/data/'
```

想在本机真装一遍验证：
```bash
mkdir /tmp/ai && cd /tmp/ai && npm init -y
npm install /路径/agent-insight-<版本>.tgz
npx agent-insight start          # 开 http://localhost:3000
```

---

## 5. 正式发布

```bash
node scripts/publish-npm.js --version 0.1.0-beta --tag latest
```

发布成功后验证：
```bash
npm view agent-insight version dist-tags --registry https://registry.npmjs.org/
npx agent-insight@0.1.0-beta start
```

---

## 6. 常见报错排查

| 现象 | 原因 / 解决 |
|---|---|
| `❌ Not authenticated to the npm registry` | 没配 token。按 §2 配 Automation token 到 `~/.npmrc`（脚本会在 build 前就提示，不会白等） |
| `npm ci` 报 `ENOTEMPTY: rmdir ...node_modules` | npm 清理旧依赖偶发问题。先 `rm -rf node_modules` 再重跑脚本 |
| `You cannot publish over the previously published versions` | 该版本号已发过，npm 版本不可变。**改用更高版本号** |
| 发布卡在国内镜像 / 403 | 脚本已钉死 `--registry https://registry.npmjs.org/`，无需改全局；若仍异常，确认 `~/.npmrc` 没把 registry 覆盖成只读镜像 |
| 预发布版本发不上 `latest` | 脚本已自动对 `latest` 也显式带 `--tag`，正常即可。手动发请用 `npm publish --tag latest` |
| 想撤销刚发的版本 | **72 小时内**可删：`npm unpublish agent-insight@<版本> --registry https://registry.npmjs.org/`；超 72h 自己删不了（联系 npm support）。**迭代请 bump 版本号，别靠删** |

---

## 7. 关于包内容（背景知识）

- 采用 **Next.js standalone** 模式打包，包内含运行时所需依赖，体积约 30~35MB。
- **本地/临时目录不会进包**：`exclude/`（本地临时文件）、`data/`（用户数据/数据库）、`tests/`、`skillbench/` 等由 `prepack` 钩子自动剔除——**无论谁、用什么方式打包都生效**，所以不同人打出的包大小一致。
- **跨平台**：包默认带打包机平台的原生二进制（sharp、Prisma 引擎），用户 `npm install` 时由 `postinstall` 按其自身平台自愈（需联网）。因此 mac/linux/windows 打的包都能在各平台安装运行。

---

## 8. 用户侧使用（供 README/对外文档参考）

```bash
# 安装并一键部署（装包 + 起服务 + 建 Key + 配 opencode/Claude 遥测 + 加 skill）
npx agent-insight install

# 或者分步
npm install agent-insight
npx agent-insight start          # http://localhost:3000
npx agent-insight stop
npx agent-insight status
```

> `agent-insight install` 的一键流程需要包已发布到 `latest`；前提是用户机器有 Node 20+，要测 opencode 上报还需用户已装并配置好 opencode。
