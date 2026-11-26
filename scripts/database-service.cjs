const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readConfig } = require('./project-storage.cjs');
const runtime = require('./local-runtime.cjs');
const ROOT = path.resolve(__dirname, '..');
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw Error('Docker 操作失败；请确认 Docker 已启动、Compose 可用、镜像可获取且端口未被占用。已有数据不会删除。');
  return result.stdout.trim();
}
function defaults() {
  const home = '~/.agent-insight-postgresql';
  return {
    control: { backend: 'postgresql', dsn: `postgresql://agent_insight:${crypto.randomBytes(24).toString('hex')}@127.0.0.1:15432/agent_insight?connect_timeout=10&sslmode=disable`, schema: 'agent_insight', artifacts: `${home}/artifacts` },
    clickhouse: { endpoint: 'http://127.0.0.1:18123', database: 'agent_insight', user: 'agent_insight', password: crypto.randomBytes(24).toString('hex'), timeout: 15 },
    runtime: { home, corePort: 4319, webPort: 3000 },
  };
}
function service(config, name) {
  if (name === 'postgres') {
    if (config.control.backend !== 'postgresql') throw Error('独立 PostgreSQL 脚本要求 control.backend=postgresql');
    const url = new URL(config.control.dsn);
    if (url.hostname !== '127.0.0.1' || url.searchParams.get('sslmode') !== 'disable') throw Error('本机容器脚本只接受 127.0.0.1 且 sslmode=disable 的 PostgreSQL 配置；已有远程服务直接运行 install.sh');
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    if (!/^[a-z][a-z0-9_]*$/.test(database) || !/^[a-z][a-z0-9_]*$/.test(user)) throw Error('容器初始化数据库名和用户名只能使用小写字母、数字和下划线');
    return { image: 'postgres:16-alpine', restart: 'unless-stopped', environment: { POSTGRES_DB: database, POSTGRES_USER: user, POSTGRES_PASSWORD: decodeURIComponent(url.password) }, ports: [`127.0.0.1:${url.port || 5432}:5432`], volumes: ['postgres-data:/var/lib/postgresql/data'], healthcheck: { test: ['CMD', 'pg_isready', '-U', user, '-d', database], interval: '2s', timeout: '3s', retries: 45 } };
  }
  const url = new URL(config.clickhouse.endpoint);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('本机容器脚本只接受 HTTP 127.0.0.1 ClickHouse 配置；远程服务直接运行 install.sh');
  if (!config.clickhouse.password) throw Error('新建 ClickHouse 容器必须设置非空密码');
  return { image: 'clickhouse/clickhouse-server:26.8', restart: 'unless-stopped', environment: { CLICKHOUSE_DB: config.clickhouse.database, CLICKHOUSE_USER: config.clickhouse.user, CLICKHOUSE_PASSWORD: config.clickhouse.password, CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' }, ports: [`127.0.0.1:${url.port || 80}:8123`], volumes: ['clickhouse-data:/var/lib/clickhouse'], healthcheck: { test: ['CMD', 'wget', '--spider', '-q', 'http://127.0.0.1:8123/ping'], interval: '2s', timeout: '3s', retries: 45 } };
}
async function main(args = process.argv.slice(2)) {
  const [name, ...options] = args;
  if (!['postgres', 'clickhouse'].includes(name)) throw Error('请选择 postgres 或 clickhouse');
  if (options.includes('--help')) { console.log('bash scripts/start_postgresql.sh [--config FILE] [--stop]\nbash scripts/start_clickhouse.sh [--config FILE] [--stop]\n首次创建 config/storage.local.json；已有配置不覆盖。Docker 必须已启动。'); return; }
  let file = path.join(ROOT, 'config/storage.local.json'), stop = false;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--config' && options[i + 1]) file = path.resolve(options[++i]);
    else if (options[i] === '--stop') stop = true;
    else throw Error('未知参数，使用 --help 查看用法');
  }
  docker(['info', '--format', '{{.ServerVersion}}']);
  docker(['compose', 'version']);
  const project = 'insight-db-' + crypto.createHash('sha256').update(file).digest('hex').slice(0, 12);
  if (!fs.existsSync(file)) {
    if (stop) throw Error('配置文件不存在，无法确定待停止服务');
    if (docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'])) throw Error('发现已有数据卷但配置缺失，请恢复原配置，不能生成新密码替代');
    runtime.privateWrite(file, defaults());
    console.log('[配置] 已创建私有数据库配置，随机密码不打印；请保留此文件及数据卷');
  }
  const config = readConfig(file);
  const spec = service(config, name);
  const release = await runtime.lock(config.runtime.home);
  try {
    const receipt = path.join(config.runtime.home, 'run', `database-${project}-${name}.json`);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    if (fs.existsSync(receipt) && runtime.readPrivate(receipt).fingerprint !== fingerprint) throw Error('数据库配置与已部署记录不同；请先人工完成凭据/端口迁移，不自动重建容器');
    const volume = name === 'postgres' ? 'postgres-data' : 'clickhouse-data';
    const manifest = JSON.stringify({ services: { [name]: spec }, volumes: { [volume]: {} } });
    const output = docker(['compose', '--project-name', project, '--project-directory', ROOT, '-f', '-', ...(stop ? ['stop', name] : ['up', '-d', '--wait', '--wait-timeout', '120', name])], manifest);
    if (!fs.existsSync(receipt)) runtime.privateWrite(receipt, { fingerprint });
    if (output) console.log(output);
    console.log(`[完成] ${name} ${stop ? '已停止，数据卷保留' : '已就绪'}；${path.relative(ROOT, file)}；项目安装：bash scripts/install.sh${file === path.join(ROOT, 'config/storage.local.json') ? '' : ' --config <该配置文件>'}`);
  } finally { release(); }
}
module.exports = { defaults, service, main };
if (require.main === module) main().catch(error => { console.error(`[失败] ${error.message}`); process.exitCode = 1; });
