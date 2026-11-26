const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packages = require('./clickhouse-server-packages.cjs');
const { digest } = packages;
function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(exe)} 执行失败 (${result.error?.code || result.status})`);
  return result;
}
async function clickhouse(home, env = process.env, dependencies = {}) {
  const plan = (dependencies.target ?? packages.target)('auto', { portable: true });
  const asset = plan.packages[0];
  if (env.AGENT_INSIGHT_CLICKHOUSE_BINARY) {
    const file = path.resolve(env.AGENT_INSIGHT_CLICKHOUSE_BINARY);
    fs.accessSync(file, fs.constants.X_OK);
    const version = command(file, ['--version'], { encoding: 'utf8', stdio: 'pipe' }).stdout;
    if (!version.includes('version ' + plan.version + ' ')) throw Error('指定 ClickHouse 程序版本与正式发布清单不一致');
    return file;
  }
  const dir = path.join(home, 'runtime', `clickhouse-${plan.version}`);
  const binary = path.join(dir, 'clickhouse');
  const receipt = path.join(dir, 'installed.json');
  if (fs.existsSync(binary) && fs.existsSync(receipt)) {
    const installed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (installed.packageHash !== asset.sha256 || installed.binaryHash !== await digest(binary) ||
        (installed.platform && installed.platform !== plan.platform) || (installed.machine && installed.machine !== plan.machine)) {
      throw new Error('ClickHouse 程序校验失败，请检查安装目录与运行平台');
    }
    return binary;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cache = path.join(dir, 'packages', plan.platform, plan.machine);
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const previous = path.join(dir, asset.name + '.download');
  if (!fs.existsSync(path.join(cache, asset.name)) && await packages.verified(previous, asset)) {
    fs.copyFileSync(previous, path.join(cache, asset.name));
  }
  const archive = await (dependencies.acquire ?? packages.acquire)(asset, cache, env.AGENT_INSIGHT_CLICKHOUSE_PACKAGE_DIR);
  if (!await packages.verified(archive, asset)) throw Error('ClickHouse 安装包 SHA-256 不匹配，拒绝执行');
  if (asset.name.endsWith('.tgz')) {
    const member = `clickhouse-common-static-${plan.version}/usr/bin/clickhouse`;
    const extracted = path.join(dir, 'unpack');
    fs.mkdirSync(extracted, { recursive: true, mode: 0o700 });
    command('tar', ['-xzf', archive, '-C', extracted, member]);
    fs.copyFileSync(path.join(extracted, member), binary);
  } else fs.copyFileSync(archive, binary);
  fs.chmodSync(binary, 0o700);
  // Official native binaries may expand themselves on first execution. Seal the expanded file.
  command(binary, ['--version']);
  fs.writeFileSync(receipt, JSON.stringify({ version: plan.version, platform: plan.platform, machine: plan.machine,
    packageHash: asset.sha256, binaryHash: await digest(binary) }), { mode: 0o600 });
  return binary;
}
function python(home, env = process.env) {
  if (env.AGENT_INSIGHT_STORAGE_PYTHON) {
    const exe = path.resolve(env.AGENT_INSIGHT_STORAGE_PYTHON);
    command(exe, ['-c', 'import sys; assert sys.version_info >= (3,11); import yaml'], { stdio: 'pipe' });
    return exe;
  }
  const dir = path.join(home, 'runtime', 'python');
  const exe = path.join(dir, 'bin', 'python');
  if (!fs.existsSync(exe)) {
    command('python3', ['-c', 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ required"']);
    command('python3', ['-m', 'venv', dir]);
  }
  const result = spawnSync(exe, ['-c', 'import yaml'], { stdio: 'ignore' });
  if (result.status !== 0) command(exe, ['-m', 'pip', 'install', 'PyYAML==6.0.3']);
  return exe;
}
module.exports = { clickhouse, python, command, digest };
