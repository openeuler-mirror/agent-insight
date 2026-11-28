const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const runtime = require('./local-runtime.cjs');
const installer = require('./local-runtime-install.cjs');
const ROOT = path.resolve(__dirname, '..');
const fail = message => { throw new Error(message); };
const resolvePath = value => path.resolve(ROOT, value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);

function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是对象`);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} 存在未知配置项，请参照 config/storage.*.example.json`);
}
function string(value, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || /YOUR_[A-Z_]+/i.test(value)) fail(`${label} 未填写或仍是样例占位符`);
  return value;
}
function readConfig(file = path.join(ROOT, 'config/storage.local.json')) {
  if (!fs.existsSync(file)) fail('缺少 config/storage.local.json；请复制 storage.sqlite.example.json 或 storage.postgresql.example.json，填写后 chmod 600');
  const config = runtime.readPrivate(file);
  keys(config, ['control', 'clickhouse', 'runtime', 'trace_list_optimization', 'max_concurrent_requests'], '配置');
  const c = config.control;
  keys(c, ['backend', 'database', 'dsn', 'schema', 'artifacts', 'connection_pool'], 'control');
  const capacity = config.max_concurrent_requests;
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1 || capacity > 256)) {
    console.warn('[警告] max_concurrent_requests 需要 1–256 的整数，本次已使用默认值 64。');
    config.max_concurrent_requests = 64;
  }
  if (config.trace_list_optimization !== undefined) {
    keys(config.trace_list_optimization, ['enabled'], 'trace_list_optimization');
    if (typeof config.trace_list_optimization.enabled !== 'boolean') fail('trace_list_optimization.enabled 必须为布尔值');
  }
  if (c.connection_pool !== undefined) {
    keys(c.connection_pool, ['enabled', 'min_idle', 'max_size', 'acquire_timeout_seconds', 'connect_timeout_seconds', 'idle_timeout_seconds', 'max_lifetime_seconds', 'health_check_idle_seconds'], 'control.connection_pool');
    if (c.backend !== 'postgresql') fail('connection_pool 仅适用于 PostgreSQL');
  }
  if (!['sqlite', 'postgresql', 'opengauss'].includes(c.backend)) fail('control.backend 必须是 sqlite、postgresql 或 opengauss');
  if (c.backend === 'sqlite') {
    if (c.dsn || c.schema || c.artifacts) fail('SQLite 仅接受 database；制品目录为 database.artifacts');
    c.database = resolvePath(string(c.database, 'control.database'));
    if (fs.existsSync(c.database) && fs.lstatSync(c.database).isSymbolicLink()) fail('SQLite 文件不能为符号链接');
  } else {
    if (c.database) fail('PostgreSQL/openGauss 使用 dsn，不接受 database');
    let url;
    string(c.dsn, 'control.dsn');
    try { url = new URL(c.dsn); } catch { fail('control.dsn 必须填写完整 PostgreSQL URI（密码特殊字符需 URL 编码）'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2 || url.hash) fail('control.dsn 缺少主机、数据库、用户名或密码');
    if (!url.searchParams.has('connect_timeout')) url.searchParams.set('connect_timeout', '10');
    if (!/^\d+$/.test(url.searchParams.get('connect_timeout')) || Number(url.searchParams.get('connect_timeout')) < 1 || Number(url.searchParams.get('connect_timeout')) > 60) fail('connect_timeout 必须为 1–60 秒');
    c.dsn = url.toString();
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(string(c.schema, 'control.schema')) || ['public', 'information_schema'].includes(c.schema) || c.schema.startsWith('pg_')) fail('control.schema 必须为独立的非系统 schema');
    c.artifacts = resolvePath(string(c.artifacts, 'control.artifacts'));
  }
  const ch = config.clickhouse;
  keys(ch, ['endpoint', 'database', 'user', 'password', 'timeout'], 'clickhouse');
  let url;
  string(ch.endpoint, 'clickhouse.endpoint');
  try { url = new URL(ch.endpoint); } catch { fail('clickhouse.endpoint 必须为 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('ClickHouse 地址不得包含密码、路径或查询参数');
  ch.endpoint = url.origin;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(string(ch.database, 'clickhouse.database')) || ['system', 'default', 'information_schema', 'INFORMATION_SCHEMA'].includes(ch.database)) fail('ClickHouse 需要独立业务数据库');
  string(ch.user, 'clickhouse.user'); string(ch.password, 'clickhouse.password', true);
  ch.timeout ??= 15;
  if (!Number.isInteger(ch.timeout) || ch.timeout < 1 || ch.timeout > 60) fail('ClickHouse timeout 必须为 1–60 秒');
  config.runtime ??= {};
  keys(config.runtime, ['home', 'corePort', 'webPort'], 'runtime');
  config.runtime.home = resolvePath(string(config.runtime.home ?? '~/.agent-insight', 'runtime.home'));
  config.runtime.corePort = runtime.port(config.runtime.corePort, 4319);
  config.runtime.webPort = runtime.port(config.runtime.webPort, 3000);
  if (config.runtime.corePort === config.runtime.webPort) fail('Core 和 Web 端口不能相同');
  return config;
}
function python(config, env, apply) {
  const executable = env.AGENT_INSIGHT_STORAGE_PYTHON || path.join(config.runtime.home, 'runtime/python/bin/python');
  if (apply && config.control.backend !== 'sqlite' && !env.AGENT_INSIGHT_STORAGE_PYTHON && !fs.existsSync(executable)) {
    const candidate = ['python3.13', 'python3.12', 'python3.11'].find(command => spawnSync(command, ['-c', 'import sys; assert (3,11) <= sys.version_info < (3,14)'], { stdio: 'ignore' }).status === 0);
    if (!candidate) fail('PostgreSQL/openGauss 驱动需要 Python 3.11–3.13；请安装兼容 Python 或配置 AGENT_INSIGHT_STORAGE_PYTHON');
    installer.command(candidate, ['-m', 'venv', path.dirname(path.dirname(executable))]);
  }
  const selected = apply ? installer.python(config.runtime.home, env) : fs.existsSync(executable) ? executable : 'python3';
  if (config.control.backend !== 'sqlite') {
    if (spawnSync(selected, ['-c', 'import psycopg2'], { stdio: 'ignore' }).status !== 0) {
      if (!apply) fail('预检查需要 psycopg2；请在 Python 环境安装 services/storage/requirements-relational.txt，或执行安装入口准备依赖');
      if (spawnSync(selected, ['-c', 'import sys; assert (3,11) <= sys.version_info < (3,14)'], { stdio: 'ignore' }).status !== 0) fail('当前 Python 不兼容固定 PostgreSQL 驱动，请通过 AGENT_INSIGHT_STORAGE_PYTHON 指定 Python 3.11–3.13 环境');
      installer.command(selected, ['-m', 'pip', 'install', '--only-binary=:all:', '-r', path.join(ROOT, 'services/storage/requirements-relational.txt')]);
    }
  }
  return selected;
}
function probe(config, executable, apply = false, stateFile) {
  const result = spawnSync(executable, [path.join(__dirname, 'project-storage.py'), apply ? 'initialize' : 'check'], {
    input: JSON.stringify({ ...config, stateFile }), encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PYTHONPATH: ROOT }, timeout: 180000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail(result.stderr?.trim() || '数据库检查超时或 Python 运行环境不可用');
  const report = JSON.parse(result.stdout);
  console.log(`[数据库] ${config.control.backend}: ${report.transaction}；ClickHouse: ${report.clickhouse}`);
  return report;
}
function configurationFile(config, home) {
  const directory = path.join(home, 'storage/core');
  const file = path.join(directory, 'external-service.json');
  let previous = fs.existsSync(file) ? runtime.readPrivate(file) : null;
  const controller = path.join(directory, 'external-controller-key');
  if (!fs.existsSync(controller)) runtime.privateWrite(controller, crypto.randomBytes(32).toString('hex'));
  else {
    const stat = fs.lstatSync(controller);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) fail('controller 必须为 0600 普通文件');
  }
  const cfg = { control: config.control, clickhouse: config.clickhouse,
    max_concurrent_requests: config.max_concurrent_requests ?? 64,
    ...(config.trace_list_optimization === undefined ? {} : { trace_list_optimization: config.trace_list_optimization }),
    port: config.runtime.corePort, controller_key_file: controller,
    cursor_secret_hex: previous?.cursor_secret_hex || crypto.randomBytes(32).toString('hex'),
    default_workspace: 'default', worker_enabled: true };
  if (previous && JSON.stringify(previous) !== JSON.stringify(cfg) && runtime.alive(runtime.record(home, 'core'))) fail('配置已变更，请先 bash scripts/stop.sh，再启动以应用新配置');
  if (!previous || JSON.stringify(previous) !== JSON.stringify(cfg)) {
    const temp = file + '.' + crypto.randomUUID();
    runtime.privateWrite(temp, cfg); fs.renameSync(temp, file);
  }
  return { file, cfg };
}
function legacyGuard(config, env) {
  const old = path.join(config.runtime.home, 'data/witty_insight.db');
  if (env.DATABASE_URL || env.DB_HOST || env.DB_NAME) fail('检测到旧数据库环境变量，请先确认历史迁移并移除旧连接配置');
  if (fs.existsSync(old)) fail('检测到旧业务数据库；请先显式备份迁移，不能以空库替代历史数据');
  const previous = path.join(config.runtime.home, 'storage/core/trace-service.json');
  if (fs.existsSync(previous)) {
    const before = runtime.readPrivate(previous);
    const a = before.control, b = config.control;
    if (a.backend !== b.backend || (a.backend === 'sqlite' ? a.database !== b.database : a.dsn !== b.dsn || a.schema !== b.schema) || before.clickhouse.endpoint.replace(/\/$/, '') !== config.clickhouse.endpoint || before.clickhouse.database !== config.clickhouse.database) fail('检测到已有 Core，项目配置指向不同数据库；请迁移数据或为独立环境指定新的 runtime.home');
  }
}
async function main(args = process.argv.slice(2)) {
  const [action, ...options] = args;
  if (options.includes('--help')) { console.log('install.sh [--check|--storage-only] [--config FILE]\nstart.sh / develop_start.sh：仅启动 Core 和 Web；stop.sh：仅停止 Core 和 Web'); return; }
  let file = path.join(ROOT, 'config/storage.local.json'), check = false, storageOnly = false;
  const webArgs = [];
  let webPort = process.env.AGENT_INSIGHT_PORT;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--config' && options[i + 1]) file = path.resolve(options[++i]);
    else if (options[i] === '--check') check = true;
    else if (options[i] === '--storage-only') storageOnly = true;
    else if (action === 'production' && options[i] === '--force-rebuild') webArgs.push(options[i]);
    else if (['production', 'dev'].includes(action) && options[i] === '--port') {
      if (!options[i + 1]) fail('--port 缺少参数值');
      webPort = options[++i];
    }
    else if (options[i] !== '--apply') fail(`不支持的参数：${options[i]}；使用 --help 查看用法`);
  }
  if (!['install', 'production', 'dev', 'stop', 'status'].includes(action)) fail('未知项目操作');
  if (action !== 'install' && (check || storageOnly)) fail('--check/--storage-only 仅用于 install');
  if (webPort !== undefined && (!/^\d+$/.test(webPort) || Number(webPort) < 1 || Number(webPort) > 65535)) fail(`AGENT_INSIGHT_PORT / --port 必须是 1 到 65535 的整数：${webPort}`);
  if (process.env.DATABASE_URL || process.env.DB_HOST || process.env.DB_NAME) fail('检测到旧数据库连接配置，请先确认历史迁移并移除旧连接配置');
  const config = readConfig(file), home = config.runtime.home;
  if (webPort !== undefined) config.runtime.webPort = Number(webPort);
  if (config.runtime.webPort === config.runtime.corePort) fail('Core 和 Web 端口不能相同');
  const env = { ...process.env, AGENT_INSIGHT_HOME: home, AGENT_INSIGHT_PORT: String(config.runtime.webPort),
    AGENT_INSIGHT_STORAGE_CORE_URL: `http://127.0.0.1:${config.runtime.corePort}` };
  if (action === 'stop') {
    const unlock = await runtime.lock(home);
    try { for (const name of ['web', 'core']) await runtime.stop(home, name); } finally { unlock(); }
    console.log('[完成] Core/Web 已停止，数据库由用户管理，保持运行'); return;
  }
  if (action === 'status') {
    for (const name of ['web', 'core']) console.log(`${name}: ${runtime.alive(runtime.record(home, name)) ? '运行中' : '未运行'}`);
    console.log('数据库由用户管理；install.sh --check 检查连接与结构'); return;
  }
  legacyGuard(config, process.env);
  const apply = action === 'install' && !check;
  if (check) { probe(config, python(config, env, false), false, path.join(home, 'storage/core/external-initialization.json')); return; }
  const executable = python(config, env, apply);
  const state = path.join(home, 'storage/core/external-initialization.json');
  async function prepare(current, started) {
    const report = probe(config, executable, apply, state);
    if (report.transaction !== 'ready' || report.clickhouse !== 'ready') fail('数据库尚未初始化，请先 bash scripts/install.sh');
    const { file: derived, cfg } = configurationFile(config, home);
    const prepared = { ...current, ...runtime.coreEnvironment(cfg, env), AGENT_INSIGHT_STORAGE_CORE_CONFIG: derived };
    if (runtime.alive(runtime.record(home, 'core'))) {
      if (!runtime.record(home, 'core').args.includes(derived)) fail('正在运行旧配置 Core，请先停止应用再重试');
    } else {
      await runtime.assertFree(cfg.port);
      await runtime.launch(home, 'core', executable, ['-m', 'services.storage.trace_service', '--config', derived], { ...prepared, PYTHONPATH: ROOT });
      started.push('core');
    }
    await runtime.waitReady(home, 'core', async () => { try { await require('./storage-core-preflight.cjs').preflight(prepared); return true; } catch { return false; } });
    return prepared;
  }
  if (storageOnly) {
    const unlock = await runtime.lock(home);
    try { probe(config, executable, true, state); configurationFile(config, home); }
    finally { unlock(); }
    console.log('[完成] 存储初始化与检查完成，未启动应用'); return;
  }
  const dependencies = async () => {
    if (apply && !fs.existsSync(path.join(ROOT, 'node_modules'))) {
      if (await runtime.runChild('npm', ['ci', '--include=dev'], env)) fail('应用依赖安装失败');
    }
  };
  await runtime.start(home, env, action === 'dev' ? 'dev' : 'production', webArgs, { prepare, prepareDependencies: dependencies });
}
module.exports = { readConfig, probe, legacyGuard, configurationFile, main };
if (require.main === module) main().catch(error => { console.error(`[失败] ${error.message}`); process.exitCode = 1; });
