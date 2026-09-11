'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const SOURCE_DIRS = ['src', 'public', 'prisma', 'scripts', 'skills', 'examples'];

async function sourceFingerprint(project, env) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([process.version, process.platform, process.arch, Object.entries(env).filter(([key]) => key.startsWith('NEXT_PUBLIC_')).sort()]));
  async function visit(relative) {
    const absolute = path.join(project, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) { hash.update(relative + '\0' + await fs.readlink(absolute)); return; }
    if (stat.isDirectory()) {
      if (['node_modules', '.next', '__pycache__', '.git', 'dist', 'build'].includes(path.basename(relative))) return;
      for (const name of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile() && !/\.(log|pid|pyc|tsbuildinfo)$/.test(relative)) {
      hash.update(relative + '\0');
      hash.update(await fs.readFile(absolute));
    }
  }
  const roots = (await fs.readdir(project)).filter(name => SOURCE_DIRS.includes(name) || /^(package(-lock)?\.json|next\.config\..+|tsconfig.*\.json|postcss\.config\..+|tailwind\.config\..+|\.npmrc|\.env(\.production)?(\.local)?)$/.test(name));
  for (const name of roots.sort()) await visit(name);
  return hash.digest('hex');
}

async function findStandaloneApp(root) {
  async function walk(directory) {
    if (await fs.stat(path.join(directory, 'server.js')).then(s => s.isFile(), () => false)
      && await fs.stat(path.join(directory, '.next/required-server-files.json')).then(s => s.isFile(), () => false)) return directory;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['node_modules', '.next'].includes(entry.name)) continue;
      const found = await walk(path.join(directory, entry.name));
      if (found) return found;
    }
    return null;
  }
  const app = await walk(root);
  if (!app) throw new Error('未找到 Next.js standalone 生产产物，请检查构建日志。');
  return app;
}

function runLogged(command, args, { cwd, env, logFile }) {
  return new Promise((resolve, reject) => {
    const log = require('node:fs').openSync(logFile, 'a', 0o600);
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', log, log] });
    require('node:fs').closeSync(log);
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`命令执行失败（${code ?? signal}），请查看日志：${logFile}`)));
  });
}

async function prepareProductionBuild({ project, dataRoot, env, rebuild = false, build }) {
  const projectId = createHash('sha256').update(project).digest('hex').slice(0, 16);
  const directory = path.join(dataRoot, '.production-build', projectId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const fingerprint = await sourceFingerprint(project, env);
  const marker = path.join(directory, 'current.json');
  if (!rebuild) {
    try {
      const cached = JSON.parse(await fs.readFile(marker, 'utf8'));
      const release = path.resolve(directory, cached.release);
      const cwd = path.resolve(release, cached.app);
      if (cached.fingerprint === fingerprint && release.startsWith(directory + path.sep) && (cwd === release || cwd.startsWith(release + path.sep))) {
        const buildId = await fs.readFile(path.join(cwd, '.next/BUILD_ID'), 'utf8');
        await fs.access(path.join(cwd, 'server.js'));
        await fs.access(path.join(cwd, '.next/static'));
        if (buildId === cached.buildId) return { entry: path.join(cwd, 'server.js'), cwd, reused: true, fingerprint };
      }
    } catch { /* 缓存不完整时重新构建，正在运行的独立产物保留。 */ }
  }
  const logFile = path.join(directory, 'build.log');
  if (build) await build();
  else {
    console.log(`正在编译生产版本，首次需要几分钟。日志：${logFile}`);
    await runLogged(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: project, env, logFile });
  }
  if (await sourceFingerprint(project, env) !== fingerprint) throw new Error('构建期间源码发生变化，请再次执行启动命令；原服务保持运行。');
  const standalone = path.join(project, '.next/standalone');
  const sourceApp = await findStandaloneApp(standalone);
  const release = `${fingerprint.slice(0, 16)}-${randomUUID().slice(0, 8)}`;
  const destination = path.join(directory, release);
  await fs.cp(standalone, destination, { recursive: true });
  const app = path.relative(standalone, sourceApp);
  const cwd = path.join(destination, app);
  await fs.cp(path.join(project, '.next/static'), path.join(cwd, '.next/static'), { recursive: true });
  if (await fs.stat(path.join(project, 'public')).then(s => s.isDirectory(), () => false)) await fs.cp(path.join(project, 'public'), path.join(cwd, 'public'), { recursive: true });
  const buildId = await fs.readFile(path.join(cwd, '.next/BUILD_ID'), 'utf8');
  const temporary = marker + '.' + randomUUID();
  await fs.writeFile(temporary, JSON.stringify({ fingerprint, release, app, buildId }), { mode: 0o600 });
  await fs.rename(temporary, marker);
  return { entry: path.join(cwd, 'server.js'), cwd, reused: false, fingerprint };
}

async function withProjectLock(project, work) {
  const directory = path.join(os.tmpdir(), `ai-production-build-${process.getuid?.() ?? 'local'}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = path.join(directory, createHash('sha256').update(project).digest('hex').slice(0, 24) + '.sock');
  const server = net.createServer(socket => socket.end());
  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    await listen();
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const busy = new Error('这个仓库正在启动或构建，请等待命令结束。');
    const recovery = socketPath + '.recovery';
    try { await fs.mkdir(recovery, { mode: 0o700 }); } catch { throw busy; }
    try {
      const active = await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', error => ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve(false) : reject(error));
        socket.setTimeout(1200, () => { socket.destroy(); reject(busy); });
      });
      if (active) throw busy;
      const stat = await fs.lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat && !stat.isSocket()) throw busy;
      if (stat) await fs.unlink(socketPath);
      await listen();
    } finally { await fs.rmdir(recovery); }
  }
  try { return await work(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

module.exports = { sourceFingerprint, findStandaloneApp, prepareProductionBuild, runLogged, withProjectLock };
