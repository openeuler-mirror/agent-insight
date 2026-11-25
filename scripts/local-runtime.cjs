const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { getAgentInsightHome } = require('./agent-insight-home.cjs');
const { loadEnvironment, preflight } = require('./storage-core-preflight.cjs');
const install = require('./local-runtime-install.cjs');
const ROOT = path.resolve(__dirname, '..');
const SELF = __filename;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };
function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function privateWrite(file, value) {
  privateDir(path.dirname(file));
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
}
function readPrivate(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) fail(`私有配置权限错误：${file}（需要 0600 普通文件）`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`私有配置 JSON 无效：${file}`); }
}
function port(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) fail('端口必须为 1–65535 的整数');
  return number;
}
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return '';
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
function recordPath(home, name) { return path.join(home, 'run', `${name}.json`); }
function record(home, name) {
  const file = recordPath(home, name);
  if (!fs.existsSync(file)) return null;
  const value = readPrivate(file);
  if (value.home !== home || value.root !== ROOT) fail(`服务记录不属于当前项目：${file}`);
  return value;
}
function alive(value) { return !!value && !!value.identity && identity(value.pid) === value.identity; }
async function lock(home) {
  const dir = path.join(home, 'run', 'startup.lock');
  privateDir(path.dirname(dir));
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const ownerFile = path.join(dir, 'owner.json');
    if (!fs.existsSync(ownerFile)) fail(`启动锁尚未就绪：${dir}；请稍后重试`);
    const owner = readPrivate(ownerFile);
    if (identity(owner.pid) === owner.identity) fail('已有启动、停止或升级操作正在执行');
    // Rename rather than delete an unknown lock; concurrent reclaimers cannot both acquire it.
    fs.renameSync(dir, `${dir}.stale-${crypto.randomUUID()}`);
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  privateWrite(path.join(dir, 'owner.json'), { pid: process.pid, identity: identity(process.pid) });
  return () => { fs.unlinkSync(path.join(dir, 'owner.json')); fs.rmdirSync(dir); };
}
async function assertFree(number) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`端口 ${number} 已占用；不会停止未托管的进程`)));
    server.listen(number, '127.0.0.1', () => server.close(resolve));
  });
}
async function stop(home, name) {
  const value = record(home, name);
  if (!value) return;
  if (alive(value)) {
    console.log(`[停止] ${name}`);
    process.kill(-value.pid, 'SIGTERM');
    for (let i = 0; i < 150 && alive(value); i++) await sleep(200);
    if (alive(value)) fail(`${name} 未能在 30 秒内退出，保留进程记录；请检查日志`);
  }
  fs.unlinkSync(recordPath(home, name));
}
function rotate(file) {
  if (fs.existsSync(file) && fs.statSync(file).size >= 10 * 1024 * 1024) {
    for (let i = 2; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    fs.renameSync(file, `${file}.1`);
  }
}
async function launch(home, name, executable, args, env, cwd = ROOT) {
  const previous = record(home, name);
  if (alive(previous)) fail(`${name} 已运行`);
  if (previous) fs.unlinkSync(recordPath(home, name));
  const logfile = path.join(home, 'logs', `${name}.log`);
  privateDir(path.dirname(logfile));
  const token = crypto.randomUUID();
  const child = spawn(process.execPath, [SELF, 'supervise', home, name, token, executable, ...args], {
    cwd, env, detached: true, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const signature = identity(child.pid);
  if (!signature || !signature.includes(token)) fail(`${name} 启动失败，查看 ${logfile}`);
  const value = { pid: child.pid, identity: signature, home, root: ROOT, logfile, executable, args, cwd };
  try { privateWrite(recordPath(home, name), value); }
  catch (error) { if (identity(child.pid) === signature) process.kill(-child.pid, 'SIGTERM'); throw error; }
  return value;
}
function supervise(home, name, token, executable, args) {
  const logfile = path.join(home, 'logs', `${name}.log`);
  const write = data => { rotate(logfile); fs.appendFileSync(logfile, data, { mode: 0o600 }); };
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  child.stdout.on('data', write); child.stderr.on('data', write);
  child.once('error', error => { write(`Service failed: ${error.code}\n`); process.exitCode = 1; });
  let stopping = false;
  const terminate = () => { if (!stopping) { stopping = true; child.kill('SIGTERM'); } };
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
async function healthy(url, validate = () => true) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    return response.ok && await validate(response);
  } catch { return false; }
}
async function waitReady(home, name, check) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (!alive(record(home, name))) fail(`${name} 已退出，日志：${path.join(home, 'logs', name + '.log')}`);
    if (await check()) return;
    await sleep(1000);
  }
  fail(`${name} 就绪超时，日志：${path.join(home, 'logs', name + '.log')}`);
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function newConfiguration(home, env) {
  const core = path.join(home, 'storage', 'core');
  const ch = path.join(home, 'storage', 'clickhouse');
  const configFile = path.join(core, 'trace-service.json');
  if (fs.existsSync(configFile)) return configFile;
  const legacy = [path.join(home, 'data', 'witty_insight.db')];
  if (env.DATABASE_URL?.startsWith('file:')) legacy.push(path.resolve(ROOT, env.DATABASE_URL.slice(5)));
  if (legacy.some(file => fs.existsSync(file))) fail('检测到旧业务数据库，请先执行显式旧库迁移并配置已有 Core；不会新建空库替代历史数据');
  if (env.DB_HOST || env.DB_NAME || env.DATABASE_URL) fail('检测到旧数据库连接配置，请先核对旧库迁移和目标 Core 配置');
  const database = path.join(core, 'core.db');
  const recovery = path.join(core, 'trace-service.json.initializing');
  if (fs.existsSync(recovery)) {
    const previous = readPrivate(recovery);
    if (!fs.existsSync(path.join(core, 'managed-clickhouse.json')) || !fs.existsSync(path.join(ch, 'config.xml'))) fail('首次配置写入中断，保留初始化记录；请恢复 ClickHouse 配置后重试');
    privateWrite(configFile, previous);
    return configFile;
  }
  if (fs.existsSync(database) || fs.existsSync(path.join(ch, 'data'))) fail('检测到无配置的存储数据，请恢复原配置；不会重新初始化');
  privateDir(core); privateDir(ch);
  const chPort = port(env.AGENT_INSIGHT_CLICKHOUSE_PORT, 8123);
  const corePort = port(env.AGENT_INSIGHT_CORE_PORT, 4319);
  if (new Set([chPort, corePort, port(env.AGENT_INSIGHT_PORT, 3000)]).size !== 3) fail('Core、Web 和 ClickHouse 端口不能相同');
  const password = crypto.randomBytes(32).toString('hex');
  const controller = path.join(core, 'controller-key');
  if (!fs.existsSync(controller)) privateWrite(controller, crypto.randomBytes(32).toString('hex'));
  const cfg = {
    control: { backend: 'sqlite', database },
    clickhouse: { endpoint: `http://127.0.0.1:${chPort}`, database: 'agent_insight_core', user: 'default', password },
    cursor_secret_hex: crypto.randomBytes(32).toString('hex'), controller_key_file: controller,
    default_workspace: 'default', port: corePort, worker_enabled: true,
  };
  const memory = Number(env.AGENT_INSIGHT_CLICKHOUSE_MEMORY_MB || 2048);
  if (!Number.isInteger(memory) || memory < 512 || memory > 65536) fail('ClickHouse 内存上限必须为 512–65536 MiB');
  const configXml = `<clickhouse>
<listen_host>127.0.0.1</listen_host><http_port>${chPort}</http_port>
<path>${xml(ch)}/data/</path><tmp_path>${xml(ch)}/tmp/</tmp_path><user_files_path>${xml(ch)}/user_files/</user_files_path>
<logger><level>warning</level><console>true</console></logger>
<max_server_memory_usage>${memory * 1024 * 1024}</max_server_memory_usage><mark_cache_size>134217728</mark_cache_size>
<background_pool_size>2</background_pool_size><background_schedule_pool_size>4</background_schedule_pool_size>
<background_buffer_flush_schedule_pool_size>1</background_buffer_flush_schedule_pool_size><background_message_broker_schedule_pool_size>1</background_message_broker_schedule_pool_size><background_distributed_schedule_pool_size>1</background_distributed_schedule_pool_size>
<merge_tree><number_of_free_entries_in_pool_to_lower_max_size_of_merge>0</number_of_free_entries_in_pool_to_lower_max_size_of_merge><number_of_free_entries_in_pool_to_execute_mutation>0</number_of_free_entries_in_pool_to_execute_mutation><number_of_free_entries_in_pool_to_execute_optimize_entire_partition>0</number_of_free_entries_in_pool_to_execute_optimize_entire_partition></merge_tree>
<profiles><default><max_threads>2</max_threads><max_memory_usage>${Math.floor(memory * 0.5) * 1024 * 1024}</max_memory_usage></default></profiles>
<users><default><password_sha256_hex>${crypto.createHash('sha256').update(password).digest('hex')}</password_sha256_hex><networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota><access_management>1</access_management></default></users>
<quotas><default><interval><duration>3600</duration><queries>0</queries><errors>0</errors><result_rows>0</result_rows><read_rows>0</read_rows><execution_time>0</execution_time></interval></default></quotas>
</clickhouse>\n`;
  // Persist the recovery intent before creating either database.
  privateWrite(recovery, cfg);
  const xmlFile = path.join(ch, 'config.xml');
  privateWrite(xmlFile, configXml);
  privateWrite(path.join(core, 'managed-clickhouse.json'), { config: xmlFile, data: path.join(ch, 'data'), endpoint: cfg.clickhouse.endpoint,
    webPort: port(env.AGENT_INSIGHT_PORT, 3000) });
  privateWrite(configFile, cfg);
  return configFile;
}
function configured(home, env) {
  if (env.AGENT_INSIGHT_STORAGE_CORE_CONFIG) return path.resolve(env.AGENT_INSIGHT_STORAGE_CORE_CONFIG);
  const local = path.join(home, 'storage', 'core', 'trace-service.json');
  if (env.AGENT_INSIGHT_STORAGE_CORE_URL && !fs.existsSync(local)) return null;
  return fs.existsSync(local) ? local : newConfiguration(home, env);
}
function coreEnvironment(config, env) {
  const url = `http://127.0.0.1:${port(config.port)}`;
  if (env.AGENT_INSIGHT_STORAGE_CORE_URL && env.AGENT_INSIGHT_STORAGE_CORE_URL.replace(/\/$/, '') !== url) fail('Core URL 与所选服务配置不一致');
  if (env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE && env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE !== config.controller_key_file) fail('controller 路径与所选 Core 配置不一致');
  return { ...env, AGENT_INSIGHT_STORAGE_CORE_URL: url, AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE: config.controller_key_file };
}
async function ensureStorage(home, env, started) {
  for (const key of ['AGENT_INSIGHT_TRACE_STORAGE', 'NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE']) {
    if (env[key] && env[key] !== 'core') fail('Legacy storage is no longer supported; configure Storage Core and ClickHouse');
  }
  const file = configured(home, env);
  if (!file) { await preflight(env); console.log('[复用] 外部 Storage Core 与数据库'); return env; }
  const config = readPrivate(file);
  env = coreEnvironment(config, env);
  const python = install.python(home, env);
  const managedFile = path.join(path.dirname(file), 'managed-clickhouse.json');
  if (fs.existsSync(managedFile)) {
    const managed = readPrivate(managedFile);
    if (managed.endpoint !== config.clickhouse.endpoint) fail('ClickHouse 托管记录与 Core 配置不一致');
    const existingCH = record(home, 'clickhouse');
    if (alive(existingCH) && !existingCH.args.includes(`--config-file=${managed.config}`)) fail('已运行 ClickHouse 使用其他配置，请先停止后切换');
    if (!alive(existingCH)) {
      await assertFree(port(new URL(managed.endpoint).port, 8123));
      const binary = await install.clickhouse(home, env);
      await launch(home, 'clickhouse', binary, ['server', `--config-file=${managed.config}`], env);
      started.push('clickhouse');
    }
    await waitReady(home, 'clickhouse', () => healthy(managed.endpoint + '/ping', async r => (await r.text()).trim() === 'Ok.'));
  } else console.log('[外部] ClickHouse：仅检查，不负责启停');
  install.command(python, [path.join(__dirname, 'local-storage.py'), 'prepare', '--config', file], { env: { ...env, PYTHONPATH: ROOT } });
  if (!alive(record(home, 'core'))) {
    await assertFree(config.port);
    await launch(home, 'core', python, ['-m', 'services.storage.trace_service', '--config', file], { ...env, PYTHONPATH: ROOT });
    started.push('core');
  } else {
    const existing = record(home, 'core');
    if (!existing.args.includes(file)) fail('已运行 Core 使用其他配置，请先停止后切换');
  }
  await waitReady(home, 'core', async () => { try { await preflight(env); return true; } catch { return false; } });
  console.log('[就绪] Storage Core：事务库 + ClickHouse');
  return env;
}
async function productionStorage(home, env, check = preflight) {
  let file = env.AGENT_INSIGHT_STORAGE_CORE_CONFIG;
  if (!file && !env.AGENT_INSIGHT_STORAGE_CORE_URL) {
    const existing = path.join(home, 'storage', 'core', 'trace-service.json');
    if (fs.existsSync(existing)) file = existing;
  }
  if (file) env = coreEnvironment(readPrivate(file), env);
  if (!env.AGENT_INSIGHT_STORAGE_CORE_URL && (env.DATABASE_URL || env.DB_HOST || env.DB_NAME)) {
    fail('检测到旧数据库连接配置，请先部署 Storage Core 并按需迁移历史数据');
  }
  if (!env.AGENT_INSIGHT_STORAGE_CORE_URL) fail('生产启动需要已部署并运行的 Storage Core。请先完成服务器部署并配置 Core 地址和 controller');
  await check(env);
  return env;
}
function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit' });
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
    const cleanup = () => { process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', code => { cleanup(); resolve(code ?? 1); });
  });
}
function checkWebDependencies(root = ROOT) {
  const project = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = project.dependencies?.next;
  if (!declared) return;
  let installed;
  try { installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/next/package.json'), 'utf8')).version; }
  catch { fail('缺少 Next.js 依赖，请先执行 npm install 恢复项目声明的依赖'); }
  if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(declared) && installed !== declared) {
    fail(`Next.js 安装版本 ${installed} 与项目声明 ${declared} 不一致；请执行 npm install 恢复已声明依赖`);
  }
}
async function start(home, env, mode, args, { prepareDependencies, prepare } = {}) {
  if (!['dev', 'production'].includes(mode)) fail('未知 Web 模式');
  if (args.includes('--help') || args.includes('-h')) return runChild('bash', [path.join(__dirname, 'start.sh'), ...args], { ...env, AGENT_INSIGHT_RUNTIME_CHILD: '1' });
  for (let i = 0; i < args.length; i++) {
    if (mode === 'production' && args[i] === '--force-rebuild') continue;
    if (mode === 'production' && args[i] === '--port' && args[i + 1]) { port(args[++i]); continue; }
    fail(`不支持的启动参数：${args[i]}`);
  }
  const release = await lock(home);
  const started = [];
  let startingWeb = false;
  try {
    if (prepareDependencies) await prepareDependencies(env);
    checkWebDependencies();
    const index = args.indexOf('--port');
    const webPort = port(index >= 0 ? args[index + 1] : env.AGENT_INSIGHT_PORT, 3000);
    if (prepare) {
      if (!alive(record(home, 'web'))) await assertFree(webPort);
      env = await prepare(env, started);
    }
    if (mode === 'production') env = await productionStorage(home, env);
    await stop(home, 'web');
    await assertFree(webPort);
    if (mode === 'dev' && !prepare) env = await ensureStorage(home, env, started);
    startingWeb = true;
    const code = await runChild('bash', [path.join(__dirname, mode === 'dev' ? 'develop_start.sh' : 'start.sh'), ...args], { ...env, AGENT_INSIGHT_RUNTIME_CHILD: '1', AGENT_INSIGHT_HOME: home, AGENT_INSIGHT_PORT: String(webPort) });
    if (code) fail(`Web 启动失败 (${code})，日志：${path.join(home, 'logs', 'web.log')}`);
    for (let sample = 0; sample < 3; sample++) {
      await sleep(1000);
      if (!alive(record(home, 'web'))) fail('Web 进程已退出，不能仅凭缓存的登录凭据判定就绪');
    }
    console.log(`[完成] ${mode} Web 已就绪；状态：bash scripts/status.sh；停止：bash scripts/stop.sh`);
  } catch (error) {
    if (startingWeb) await stop(home, 'web').catch(e => console.error(e.message));
    for (const name of started.reverse()) await stop(home, name).catch(e => console.error(e.message));
    throw error;
  } finally { release(); }
}
async function status(home, env) {
  for (const name of ['web', 'core', 'clickhouse']) {
    const value = record(home, name);
    console.log(`${name}: ${alive(value) ? '运行中 PID=' + value.pid : '未托管运行'}；日志：${path.join(home, 'logs', name + '.log')}`);
  }
  const file = env.AGENT_INSIGHT_STORAGE_CORE_CONFIG || path.join(home, 'storage/core/trace-service.json');
  if (fs.existsSync(file)) {
    const config = readPrivate(file);
    console.log(`事务库：${config.control.backend} ${config.control.database || '(外部连接)'}；Core 配置：${file}`);
    if (!fs.existsSync(path.join(path.dirname(file), 'managed-clickhouse.json'))) {
      console.log('ClickHouse 由 systemd 或外部服务管理；stop.sh 不停止该数据库');
    }
    env = coreEnvironment(config, env);
  }
  try { const health = await preflight(env); console.log(`Core 健康：ready；事务 schema=${health.schema_version}；ClickHouse schema=${health.clickhouse.schema_version}`); }
  catch (error) { console.log(`Core 健康：未就绪；${error.message}`); }
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'supervise') return supervise(args[0], args[1], args[2], args[3], args.slice(4));
  loadEnvironment();
  const home = getAgentInsightHome();
  const env = { ...process.env, AGENT_INSIGHT_HOME: home };
  if (action === 'start') return require('./project-storage.cjs').main([args[0] === 'dev' ? 'dev' : 'production', ...args.slice(1)]);
  if (action === 'launch-web') {
    const [mode, number, directory] = args;
    const p = port(number);
    await assertFree(p);
    const command = mode === 'dev' ? ['node_modules/next/dist/bin/next', 'dev', '--port', String(p), '--hostname', env.AGENT_INSIGHT_BIND_HOST || '0.0.0.0'] : [path.join(path.resolve(directory), 'server.js')];
    const value = await launch(home, 'web', process.execPath, command, { ...env, PORT: String(p), HOSTNAME: env.AGENT_INSIGHT_BIND_HOST || '0.0.0.0', NODE_OPTIONS: env.NODE_OPTIONS || '--max-old-space-size=4096' }, mode === 'dev' ? ROOT : path.resolve(directory));
    console.log(value.pid); return;
  }
  if (action === 'status') return status(home, env);
  if (action === 'stop') {
    const release = await lock(home);
    try { for (const name of ['web', 'core']) await stop(home, name); }
    finally { release(); }
    console.log('本项目托管服务已停止；数据保留'); return;
  }
  if (action === 'upgrade') return require('./local-runtime-upgrade.cjs').upgrade(home, env, args, module.exports);
  fail('Usage: local-runtime.cjs start dev|production | status | stop | upgrade --plan|--apply');
}
module.exports = { start, runChild, checkWebDependencies, lock, stop, launch, record, alive, identity, assertFree, privateWrite, readPrivate, newConfiguration, coreEnvironment, ensureStorage, productionStorage, waitReady, healthy, configured, port, ROOT };
if (require.main === module) main().catch(error => { console.error(`[失败] ${error.code || ''} ${error.message}`); process.exitCode = 1; });
