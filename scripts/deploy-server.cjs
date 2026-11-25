const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { getAgentInsightHome } = require('./agent-insight-home.cjs');
const { validateConfiguration } = require('./storage-core-preflight.cjs');
const runtime = require('./local-runtime.cjs');
const install = require('./local-runtime-install.cjs');
const { target } = require('./clickhouse-server-packages.cjs');
const { connectionFile } = require('./deploy-clickhouse.cjs');

const help = '用法: bash scripts/deploy_server.sh --plan|--apply [--format auto|binary|deb|rpm|tgz] [--package-dir /path] [--clickhouse-port 8123] [--core-port 4319] [--web-port 3000] [--core-config /path/to/trace-service.json]';
const present = file => !!fs.lstatSync(file, { throwIfNoEntry: false });
const ports = { '--clickhouse-port': 'clickhousePort', '--core-port': 'corePort', '--web-port': 'webPort' };
const formats = ['auto', 'binary', 'deb', 'rpm', 'tgz'];

function options(args) {
  if (!['--plan', '--apply'].includes(args[0])) throw Error(help);
  const result = { action: args[0] };
  const seen = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!value || seen.has(flag)) throw Error(help);
    seen.add(flag);
    if (flag === '--format' && formats.includes(value)) result.format = value;
    else if (ports[flag] && /^\d+$/.test(value)) result[ports[flag]] = runtime.port(value);
    else if (['--package-dir', '--core-config'].includes(flag) && path.isAbsolute(value)) {
      result[flag === '--core-config' ? 'coreConfig' : 'packageDir'] = path.resolve(value);
    } else throw Error(help);
  }
  return result;
}

function deploymentPaths(home) {
  const core = path.join(home, 'storage/core');
  return {
    stateFile: path.join(core, 'server-deployment.json'),
    configFile: path.join(core, 'trace-service.json'),
    controller: path.join(core, 'controller-key'),
    database: path.join(core, 'core.db'),
  };
}

function checkExternalOptions(opts) {
  if (opts.format || opts.packageDir || opts.clickhousePort || opts.corePort) {
    throw Error('接入已配置 Core 时，ClickHouse 和 Core 端口等参数由现有配置管理');
  }
}

function checkNoLegacy(home, env) {
  if (present(path.join(home, 'data/witty_insight.db')) || env.DATABASE_URL || env.DB_HOST || env.DB_NAME) {
    throw Error('检测到旧业务库或连接配置。先执行显式迁移，再通过 --core-config 接入');
  }
}

function deploymentPlan(home, env, opts, select = target) {
  for (const key of ['AGENT_INSIGHT_TRACE_STORAGE', 'NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE']) {
    if (env[key] && env[key] !== 'core') throw Error('服务器部署仅支持 Storage Core');
  }
  const paths = deploymentPaths(home);
  const state = present(paths.stateFile) ? runtime.readPrivate(paths.stateFile) : null;
  const managedFile = path.join(home, 'storage/core/managed-clickhouse.json');
  const managed = present(managedFile) ? runtime.readPrivate(managedFile) : null;
  const webPort = runtime.port(opts.webPort ?? state?.webPort ?? managed?.webPort ?? env.AGENT_INSIGHT_PORT, 3000);
  const configFile = opts.coreConfig || env.AGENT_INSIGHT_STORAGE_CORE_CONFIG;
  if (configFile && ((!state && !managed) || path.resolve(configFile) !== paths.configFile)) {
    if (state) throw Error('该运行目录已有服务器部署。请使用独立运行目录接入其他 Core');
    checkExternalOptions(opts);
    const file = path.resolve(configFile);
    if (present(path.join(path.dirname(file), 'managed-clickhouse.json')) || present(file + '.initializing')) {
      throw Error('服务器部署需要已经初始化的 Core 配置。开发环境托管的 ClickHouse 请先独立迁移');
    }
    const config = runtime.readPrivate(file);
    const configEnv = runtime.coreEnvironment(config, env);
    validateConfiguration(configEnv);
    if (Number(config.port) === webPort) throw Error('Core 和 Web 端口不能相同');
    return { mode: 'configured-core', webPort, file, backend: config.control.backend };
  }
  if (!state && !managed && (env.AGENT_INSIGHT_STORAGE_CORE_URL || env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE)) {
    checkExternalOptions(opts);
    const origin = new URL(validateConfiguration(env));
    const corePort = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
    if (corePort === webPort) throw Error('Core 和 Web 端口不能相同');
    return { mode: 'existing-core', webPort, origin: origin.origin };
  }

  if (managed) {
    if (state) throw Error('运行目录混用了系统服务与项目托管记录，请恢复一致的配置');
    const config = runtime.readPrivate(present(paths.configFile) ? paths.configFile : paths.configFile + '.initializing');
    const ownership = managed;
    if (ownership.config !== path.join(home, 'storage/clickhouse/config.xml') ||
        ownership.data !== path.join(home, 'storage/clickhouse/data') || ownership.endpoint !== config.clickhouse.endpoint) {
      throw Error('托管 ClickHouse 目录或连接与当前运行目录不一致');
    }
    const clickhousePort = runtime.port(new URL(config.clickhouse.endpoint).port);
    const corePort = runtime.port(config.port);
    if ((opts.clickhousePort && opts.clickhousePort !== clickhousePort) || (opts.corePort && opts.corePort !== corePort)) {
      throw Error('已有存储端口需要通过显式变更处理');
    }
    if (new Set([clickhousePort, corePort, webPort]).size !== 3) throw Error('ClickHouse、Core 和 Web 必须使用不同端口');
    const release = select(opts.format ?? 'auto', { portable: true });
    if (release.serviceManager !== 'project') throw Error('现有实例使用项目进程管理，不能切换为系统安装');
    validateConfiguration(runtime.coreEnvironment(config, env));
    return { mode: 'managed', backend: config.control.backend, webPort, clickhousePort, corePort, release, paths };
  }

  if (!state) {
    checkNoLegacy(home, env);
    const artifacts = [paths.configFile, paths.database, paths.controller, paths.configFile + '.initializing',
      path.join(home, 'storage/core/managed-clickhouse.json'), path.join(home, 'storage/clickhouse/data')];
    if (artifacts.some(present)) throw Error('运行目录已有存储数据或配置。请用 --core-config 接入，或选用全新的运行目录');
  } else if (!/^[a-f0-9]{64}$/.test(state.id)) {
    throw Error('服务器部署记录无效');
  }
  const clickhousePort = runtime.port(opts.clickhousePort ?? state?.clickhousePort ?? env.AGENT_INSIGHT_CLICKHOUSE_PORT, 8123);
  const corePort = runtime.port(opts.corePort ?? state?.corePort ?? env.AGENT_INSIGHT_CORE_PORT, 4319);
  if (clickhousePort < 1024) throw Error('ClickHouse 端口需要大于等于 1024');
  if (new Set([clickhousePort, corePort, webPort]).size !== 3) throw Error('ClickHouse、Core 和 Web 必须使用不同端口');
  const release = select(opts.format ?? state?.format ?? 'auto');
  if (state && release.serviceManager === 'project') throw Error('已有系统部署不能隐式改用项目进程管理');
  if (state && (state.format !== release.format || state.clickhousePort !== clickhousePort || state.corePort !== corePort)) {
    throw Error('运行目录已有部署记录。ClickHouse 包格式及存储端口需要通过显式变更处理');
  }
  if (state && !present(paths.configFile) && present(paths.database)) throw Error('事务库已有数据但缺少私有配置，请恢复原配置');
  runtime.coreEnvironment({ port: corePort, controller_key_file: paths.controller }, env);
  return { mode: release.serviceManager === 'project' ? 'managed' : 'native', backend: 'sqlite', webPort, corePort, clickhousePort, release, paths };
}

async function installWebDependencies(home, env) {
  const flag = path.join(home, 'run/server-npm-install.json');
  if (present(flag)) {
    if (runtime.readPrivate(flag).root !== runtime.ROOT) throw Error('依赖安装记录属于其他项目目录');
  } else {
    if (present(path.join(runtime.ROOT, 'node_modules'))) return;
    runtime.privateWrite(flag, { root: runtime.ROOT });
  }
  const code = await runtime.runChild('npm', ['ci', '--include=dev'], env);
  if (code) throw Error('应用依赖安装失败，核对 npm 输出后重试');
  fs.unlinkSync(flag);
}

function deployClickHouse(plan, opts, state, env) {
  const args = ['--apply', '--format', plan.release.format, '--port', String(plan.clickhousePort), '--deployment-id', state.id];
  if (opts.packageDir) args.push('--package-dir', opts.packageDir);
  console.log('[部署] 目标服务器 ClickHouse');
  return new Promise((resolve, reject) => {
    // Keep the installer messages on stderr and pass only the private record through the pipe.
    const child = spawn('sudo', ['--', '/bin/sh', '-c', 'output=$1; shift; "$@" >&2 && exec /bin/cat -- "$output"',
      'deploy-clickhouse', connectionFile, process.execPath, path.join(__dirname, 'deploy-clickhouse.cjs'), ...args],
    { cwd: runtime.ROOT, env, stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '';
    let oversized = false;
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.removeListener('SIGINT', terminate);
      process.removeListener('SIGTERM', terminate);
    };
    process.once('SIGINT', terminate);
    process.once('SIGTERM', terminate);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (oversized) return;
      if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 4096) {
        oversized = true;
        terminate();
      } else output += chunk;
    });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (oversized) return reject(Error('ClickHouse 私有连接记录过大'));
      if (code !== 0) return reject(Error('ClickHouse 部署失败 (' + (code ?? signal) + ')'));
      try { resolve(JSON.parse(output)); }
      catch { reject(Error('ClickHouse 私有连接记录格式无效')); }
    });
  });
}

function protectedConnection(plan, connection) {
  const endpoint = 'http://127.0.0.1:' + plan.clickhousePort;
  if (!connection || connection.endpoint !== endpoint || connection.database !== 'agent_insight_core' ||
      connection.user !== 'agent_insight' || !/^[a-f0-9]{64}$/.test(connection.password)) {
    throw Error('ClickHouse 私有连接与当前部署计划不匹配');
  }
  const { database, user, password } = connection;
  return { endpoint, database, user, password };
}

function writeCoreConfiguration(plan, connection) {
  const { configFile, database, controller } = plan.paths;
  const clickhouse = protectedConnection(plan, connection);
  if (present(configFile)) {
    const config = runtime.readPrivate(configFile);
    if (config.control.backend !== 'sqlite' || config.control.database !== database ||
        config.controller_key_file !== controller || config.port !== plan.corePort ||
        Object.keys(clickhouse).some(key => config.clickhouse[key] !== clickhouse[key])) {
      throw Error('现有 Core 配置与服务器部署记录不一致，请恢复原配置');
    }
    validateConfiguration(runtime.coreEnvironment(config, {}));
    return configFile;
  }
  if (present(database)) throw Error('事务库已有数据但缺少配置，请恢复原配置');
  if (!present(controller)) runtime.privateWrite(controller, randomBytes(32).toString('hex'));
  const config = {
    control: { backend: 'sqlite', database },
    clickhouse,
    cursor_secret_hex: randomBytes(32).toString('hex'),
    controller_key_file: controller,
    default_workspace: 'default',
    port: plan.corePort,
    worker_enabled: true,
  };
  validateConfiguration(runtime.coreEnvironment(config, {}));
  runtime.privateWrite(configFile, config);
  return configFile;
}

async function prepareProject(home, env, plan, opts, started, dependencies = {}) {
  const apply = dependencies.deployClickHouse ?? deployClickHouse;
  const prepareCore = dependencies.ensureStorage ?? runtime.ensureStorage;
  const checkPort = dependencies.assertFree ?? runtime.assertFree;
  if (plan.mode === 'managed') {
    const managedEnv = { ...env, AGENT_INSIGHT_CLICKHOUSE_PORT: String(plan.clickhousePort),
      AGENT_INSIGHT_CORE_PORT: String(plan.corePort), AGENT_INSIGHT_PORT: String(plan.webPort) };
    if (opts.packageDir) managedEnv.AGENT_INSIGHT_CLICKHOUSE_PACKAGE_DIR = opts.packageDir;
    const existing = runtime.record(home, 'core');
    if (runtime.alive(existing)) {
      if (!existing.args.includes(plan.paths.configFile)) throw Error('已运行 Core 使用其他配置');
    } else await checkPort(plan.corePort);
    if (!runtime.alive(runtime.record(home, 'clickhouse'))) await checkPort(plan.clickhousePort);
    return prepareCore(home, managedEnv, started);
  }
  const existing = runtime.record(home, 'core');
  if (plan.mode === 'existing-core') return env;
  const configPort = plan.mode === 'native' ? plan.corePort : runtime.readPrivate(plan.file).port;
  const selectedFile = plan.mode === 'native' ? plan.paths.configFile : plan.file;
  if (runtime.alive(existing)) {
    if (!existing.args.includes(selectedFile)) throw Error('已运行 Core 使用其他配置，请使用独立运行目录');
  } else await checkPort(configPort);
  if (plan.mode === 'configured-core') {
    return prepareCore(home, { ...env, AGENT_INSIGHT_STORAGE_CORE_CONFIG: plan.file }, started);
  }
  const python = (dependencies.python ?? install.python)(home, env);
  const { stateFile } = plan.paths;
  if (!present(stateFile)) {
    runtime.privateWrite(stateFile, {
      id: randomBytes(32).toString('hex'), format: plan.release.format,
      clickhousePort: plan.clickhousePort, corePort: plan.corePort, webPort: plan.webPort,
    });
  }
  const state = runtime.readPrivate(stateFile);
  const connection = await apply(plan, opts, state, env);
  const file = writeCoreConfiguration(plan, connection);
  (dependencies.initializeCore ?? ((file, python) => install.command(
    python, [path.join(__dirname, 'local-storage.py'), 'prepare-server-core', '--config', file],
    { env: { ...env, PYTHONPATH: runtime.ROOT } },
  )))(file, python);
  return prepareCore(home, { ...env, AGENT_INSIGHT_STORAGE_CORE_CONFIG: file }, started);
}

function loadEnvironment(home) {
  for (const file of [path.join(home, '.env'), path.join(runtime.ROOT, '.env')]) {
    if (present(file)) process.loadEnvFile(file);
  }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return; }
  const opts = options(args);
  if (!['linux', 'darwin'].includes(process.platform)) throw Error('当前支持 macOS 和 Linux；Windows 请在 WSL 中运行');
  if (typeof process.loadEnvFile !== 'function') throw Error('项目部署需要 Node.js 22 或更新版本');
  if (opts.action === '--apply' && process.getuid() === 0) throw Error('请用项目运行账号执行本入口。ClickHouse 系统安装步骤会单独使用 sudo');
  const home = getAgentInsightHome();
  loadEnvironment(home);
  const env = { ...process.env, AGENT_INSIGHT_HOME: home,
    AGENT_INSIGHT_BIND_HOST: process.env.AGENT_INSIGHT_BIND_HOST || '127.0.0.1' };
  const plan = deploymentPlan(home, env, opts);
  console.log(JSON.stringify({ home, ...plan }, null, 2));
  if (opts.action === '--plan') return;
  await startProject(home, env, 'production', opts);
}

async function startProject(home, env, mode, opts = { action: '--apply' }) {
  const plan = deploymentPlan(home, env, opts);
  await runtime.start(home, { ...env, AGENT_INSIGHT_PORT: String(plan.webPort) }, mode,
    mode === 'production' ? ['--port', String(plan.webPort)] : [], {
    prepareDependencies: current => installWebDependencies(home, current),
    prepare: (current, started) => prepareProject(home, current, deploymentPlan(home, current, opts), opts, started),
  });
}

module.exports = { options, deploymentPlan, prepareProject, deploymentPaths, startProject };
if (require.main === module) require('./project-storage.cjs').main(['install', ...process.argv.slice(2)]).catch(error => {
  console.error('[失败] ' + error.message);
  process.exitCode = 1;
});
