const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const { acquire, target } = require('./clickhouse-server-packages.cjs');

const stateDir = '/var/lib/agent-insight/clickhouse-deploy';
const cacheDir = '/var/cache/agent-insight/clickhouse';
const configDir = '/etc/agent-insight/clickhouse';
const connectionFile = path.join(stateDir, 'connection.json');
const database = 'agent_insight_core';
const nativeService = 'clickhouse-server.service';
const dedicatedService = 'agent-insight-clickhouse.service';
const unitFile = '/etc/systemd/system/' + dedicatedService;
const help = '用法: bash scripts/deploy_clickhouse.sh --plan|--apply [--format auto|deb|rpm|tgz] [--package-dir /path/to/official-assets] [--port 8123]';

function options(args) {
  const action = args[0];
  if (!['--plan', '--apply'].includes(action)) throw Error(help);
  const result = { action, format: 'auto', port: 8123 };
  const seen = new Set();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith('--') || seen.has(key)) throw Error(help);
    seen.add(key);
    if (key === '--format' && ['auto', 'deb', 'rpm', 'tgz'].includes(value)) result.format = value;
    else if (key === '--package-dir' && path.isAbsolute(value)) result.packageDir = path.resolve(value);
    else if (key === '--deployment-id' && /^[a-f0-9]{64}$/.test(value)) result.deploymentId = value;
    else if (key === '--port' && /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535) result.port = Number(value);
    else throw Error(help);
  }
  return result;
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  if (result.status !== 0) throw Error(command + ' ' + args[0] + ' 执行失败 (' + (result.error?.code || result.status || result.signal) + ')');
  return result.stdout?.trim();
}

function active(service) {
  return spawnSync('systemctl', ['is-active', '--quiet', service], { stdio: 'ignore' }).status === 0;
}

function checkManager(plan) {
  let detected;
  if (plan.format === 'deb') detected = run('dpkg', ['--print-architecture']);
  if (plan.format === 'rpm') detected = run('rpm', ['--eval', '%{_arch}']);
  if (detected && detected !== plan.packageArchitecture) throw Error('包管理器架构与目标机不一致: ' + detected);
}

function describe(plan, opts) {
  const tgz = plan.format === 'tgz';
  return {
    ...plan, port: opts.port, endpoint: 'http://127.0.0.1:' + opts.port,
    service: tgz ? dedicatedService : nativeService,
    binary: tgz ? '/opt/agent-insight/clickhouse/' + plan.version + '/clickhouse' : '/usr/bin/clickhouse',
    dataDirectory: tgz ? '/var/lib/agent-insight-clickhouse' : '/var/lib/clickhouse',
    packageSource: opts.packageDir || 'ClickHouse official release',
    applyRequiresRoot: true,
  };
}

function writeNew(file, contents, mode) {
  fs.writeFileSync(file, contents, { flag: 'wx', mode });
}

function readState(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077)) throw Error('部署记录必须是 root 专用普通文件');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw Error('部署记录内容无效: ' + file); }
}

function ownedDirectory(directory, mode) {
  let entry = '/';
  for (const segment of directory.split('/').filter(Boolean)) {
    entry = path.join(entry, segment);
    if (!fs.lstatSync(entry, { throwIfNoEntry: false })) fs.mkdirSync(entry, { mode });
    const stat = fs.lstatSync(entry);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022) {
      throw Error('部署目录需由 root 管理且不可由其他用户写入: ' + entry);
    }
  }
  if (mode === 0o700 && fs.statSync(directory).mode & 0o077) throw Error('部署目录需要 0700 权限: ' + directory);
}

function inspectDeployment(plan, file, deploymentId) {
  const previous = readState(file);
  const deployment = { version: plan.version, format: plan.format, machine: plan.machine, port: plan.port };
  if (previous) {
    if (previous.deploymentId !== deploymentId) throw Error('ClickHouse 已属于另一部署。使用显式 Core 配置接入已有服务');
    if (Object.keys(deployment).some(key => deployment[key] !== previous[key])) {
      throw Error('目标已有不同的 ClickHouse 部署记录。请走显式升级或迁移流程');
    }
    return previous;
  }
  if (active(nativeService) || active(dedicatedService) ||
      ['/etc/clickhouse-server/config.xml', '/usr/bin/clickhouse', '/var/lib/clickhouse', unitFile, configDir,
        '/var/lib/agent-insight-clickhouse'].some(p => fs.lstatSync(p, { throwIfNoEntry: false }))) {
    throw Error('检测到现有 ClickHouse 程序、服务或数据。请接入已有实例，或使用独立目标服务器');
  }
  return null;
}

function createDeployment(plan, file, deploymentId) {
  const state = {
    version: plan.version, format: plan.format, machine: plan.machine, port: plan.port,
    database, endpoint: plan.endpoint, deploymentId,
    bootstrap: { user: 'agent_insight_deployer', password: randomBytes(32).toString('hex') },
    runtime: { user: 'agent_insight', password: randomBytes(32).toString('hex') },
  };
  writeNew(file, JSON.stringify(state, null, 2), 0o600);
  return state;
}

async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', e => reject(Error('ClickHouse 端口不可用: ' + port + ' (' + e.code + ')')));
    listener.listen(port, '127.0.0.1', () => listener.close(resolve));
  });
}

function writeManaged(file, content, mode = 0o644) {
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile() || existing.uid !== 0 || existing.mode & 0o022 || fs.readFileSync(file, 'utf8') !== content) {
      throw Error('部署管理的文件已存在或内容不同，请人工核对: ' + file);
    }
    return;
  }
  writeNew(file, content, mode);
}

function users(state, vendor) {
  const passwordHash = account => createHash('sha256').update(account.password).digest('hex');
  const loopback = '<networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota>';
  const defaultUser = vendor ? '<default remove="remove"/>' : '';
  return '<clickhouse><users>' + defaultUser + '\n' +
    '<agent_insight_deployer><password_sha256_hex>' + passwordHash(state.bootstrap) + '</password_sha256_hex>' + loopback +
    '<access_management>1</access_management></agent_insight_deployer>\n' +
    '<agent_insight><password_sha256_hex>' + passwordHash(state.runtime) + '</password_sha256_hex>' + loopback +
    '<grants><query>GRANT SELECT, INSERT, ALTER DELETE ON ' + database + '.*</query></grants></agent_insight>\n' +
    '</users></clickhouse>\n';
}

function binaryVersion(binary, version) {
  const output = run(binary, ['--version']);
  if (/\bversion\s+([0-9.]+)/.exec(output)?.[1] !== version) throw Error('ClickHouse 可执行文件的版本不符');
}

function installVendor(plan, artifacts) {
  if (plan.format === 'deb') {
    const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
    run('apt-get', ['install', '--yes', '--no-remove', '--no-install-recommends', ...artifacts], { stdio: 'inherit', env });
  } else {
    run('dnf', ['install', '--assumeyes', '--setopt=install_weak_deps=False', ...artifacts], { stdio: 'inherit' });
  }
  binaryVersion('/usr/bin/clickhouse', plan.version);
}

function installArchive(plan, archive) {
  const binary = plan.binary;
  const prefix = path.dirname(binary);
  ownedDirectory(prefix, 0o755);
  if (!fs.existsSync(binary)) {
    const staging = fs.mkdtempSync(path.join(prefix, '.install-'));
    const member = 'clickhouse-common-static-' + plan.version + '/usr/bin/clickhouse';
    try {
      // Only stream the selected member; tar cannot create any archive-supplied path.
      const stagedBinary = path.join(staging, 'clickhouse');
      const fd = fs.openSync(stagedBinary, 'wx', 0o755);
      try { run('tar', ['-xOzf', archive, member], { stdio: ['ignore', fd, 'inherit'] }); }
      finally { fs.closeSync(fd); }
      binaryVersion(stagedBinary, plan.version);
      fs.renameSync(stagedBinary, binary);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const stat = fs.lstatSync(binary);
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022) throw Error('已存在的 ClickHouse 程序归属异常');
  binaryVersion(binary, plan.version);
  return binary;
}

function standaloneConfig(plan, usersFile) {
  return '<clickhouse><listen_host>127.0.0.1</listen_host><http_port>' + plan.port + '</http_port>' +
    '<path>' + plan.dataDirectory + '/</path><tmp_path>' + plan.dataDirectory + '/tmp/</tmp_path>' +
    '<user_files_path>' + plan.dataDirectory + '/user_files/</user_files_path>' +
    '<logger><console>true</console><level>information</level></logger>' +
    '<users_config>' + usersFile + '</users_config></clickhouse>\n';
}

function configure(plan, state, binary) {
  if (plan.format !== 'tgz') {
    writeManaged('/etc/clickhouse-server/config.d/99-agent-insight.xml',
      '<clickhouse><listen_host replace="replace">127.0.0.1</listen_host><http_port>' + plan.port +
      '</http_port><tcp_port remove="remove"/><interserver_http_port remove="remove"/></clickhouse>\n');
    writeManaged('/etc/clickhouse-server/users.d/99-agent-insight.xml', users(state, true));
    return;
  }
  ownedDirectory(configDir, 0o755);
  writeManaged(path.join(configDir, 'users.xml'), users(state, false).replace('</clickhouse>',
    '<profiles><default/></profiles><quotas><default/></quotas></clickhouse>'));
  writeManaged(path.join(configDir, 'config.xml'), standaloneConfig(plan, configDir + '/users.xml'));
  writeManaged(unitFile, '[Unit]\nDescription=Agent Insight ClickHouse server\nAfter=network.target\n\n' +
    '[Service]\nDynamicUser=yes\nStateDirectory=agent-insight-clickhouse\nStateDirectoryMode=0700\n' +
    'ExecStart=' + binary + ' server --config-file=' + configDir + '/config.xml\n' +
    'Restart=on-failure\nTimeoutStopSec=120\nLimitNOFILE=262144\n\n[Install]\nWantedBy=multi-user.target\n');
  run('systemctl', ['daemon-reload']);
}

function packagesReady(plan) {
  return plan.packages.map(({ component }) => {
    const installed = spawnSync(plan.format === 'deb' ? 'dpkg-query' : 'rpm', plan.format === 'deb'
      ? ['-W', '-f=\${Status}\n\${Version}', component]
      : ['-q', '--queryformat', '%{VERSION}', component], { encoding: 'utf8' });
    if (installed.error) throw Error('无法检查已安装软件包: ' + component);
    if (installed.status !== 0) return false;
    const [status, debVersion] = installed.stdout.trim().split('\n');
    const version = plan.format === 'deb' ? debVersion : status;
    if (version && version !== plan.version) throw Error('已安装的软件包版本不符，请走显式升级流程: ' + component);
    return version === plan.version && (plan.format !== 'deb' || status === 'install ok installed');
  }).every(Boolean);
}

async function apply(plan, opts) {
  if (process.getuid() !== 0) throw Error('--apply 需要目标服务器管理员权限，先运行 --plan 核对');
  if (!fs.existsSync('/run/systemd/system')) throw Error('此部署入口需要目标服务器运行 systemd');
  run('python3', ['-c', 'import sys; assert sys.version_info >= (3, 11)']);
  process.umask(0o022);
  ownedDirectory(stateDir, 0o700);
  const lock = path.join(stateDir, 'deployment.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; throw Error('已有部署操作，或之前异常退出。核对后处理锁: ' + lock); }
  try {
    const stateFile = path.join(stateDir, 'deployment.json');
    const readyFile = connectionFile;
    if (!active(plan.service)) await checkPort(plan.port);
    if (!fs.existsSync(stateFile) && plan.format !== 'tgz' && plan.port !== 8123) await checkPort(8123);
    let state = inspectDeployment(plan, stateFile, opts.deploymentId);
    if (!fs.existsSync(readyFile)) {
      const cache = path.join(cacheDir, plan.tag, plan.format, plan.machine);
      ownedDirectory(cache, 0o700);
      const artifacts = [];
      for (const asset of plan.packages) artifacts.push(await acquire(asset, cache, opts.packageDir));
      if (!state) {
        // Reserve this deployment only after the artifacts are available and the host is still unclaimed.
        if (!active(plan.service)) await checkPort(plan.port);
        if (plan.format !== 'tgz' && plan.port !== 8123) await checkPort(8123);
        inspectDeployment(plan, stateFile, opts.deploymentId);
        state = createDeployment(plan, stateFile, opts.deploymentId);
      }
      let binary;
      if (plan.format === 'tgz') binary = installArchive(plan, artifacts[0]);
      else if (!packagesReady(plan)) installVendor(plan, artifacts);
      else binaryVersion('/usr/bin/clickhouse', plan.version);
      if (plan.format !== 'tgz' && !packagesReady(plan)) throw Error('正式发布包安装不完整');
      configure(plan, state, binary);
      run('systemctl', ['enable', plan.service], { stdio: 'inherit' });
      run('systemctl', ['restart', plan.service], { stdio: 'inherit' });
    } else {
      if (!state) throw Error('存在连接文件但缺少部署记录，请先检查服务器状态');
      readState(readyFile);
      if (plan.format !== 'tgz' && !packagesReady(plan)) throw Error('官方发布包已不完整，请检查服务器上的安装');
      binaryVersion(plan.binary, plan.version);
      run('systemctl', ['start', plan.service], { stdio: 'inherit' });
    }
    const python = ['scripts/local-storage.py', 'prepare-server-clickhouse', '--config', stateFile];
    if (fs.existsSync(readyFile)) python.push('--verify-only');
    run('python3', python, { stdio: 'inherit', timeout: 180000 });
    writeManaged(readyFile, JSON.stringify({ endpoint: state.endpoint, database: state.database, ...state.runtime }, null, 2) + '\n', 0o600);
    console.log('ClickHouse 已就绪。将此私有连接文件的内容用作 Storage Core 配置中的 clickhouse 对象: ' + readyFile);
  } finally { fs.rmdirSync(lock); }
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(help); return; }
  const opts = options(args);
  const selected = target(opts.format);
  if (selected.serviceManager !== 'systemd') throw Error('当前环境使用项目进程管理，请执行 bash scripts/deploy_server.sh --apply');
  const plan = describe(selected, opts);
  checkManager(plan);
  console.log(JSON.stringify(plan, null, 2));
  if (opts.action === '--apply') await apply(plan, opts);
}

module.exports = { options, describe, users, standaloneConfig, connectionFile };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error('[失败] ' + error.message);
  process.exitCode = 1;
});
