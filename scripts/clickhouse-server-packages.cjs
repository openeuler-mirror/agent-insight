const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const release = require('./clickhouse-server-release.json');

const repository = 'https://github.com/ClickHouse/ClickHouse';
const assetApi = 'https://api.github.com/repos/ClickHouse/ClickHouse/releases/assets';
const components = ['clickhouse-common-static', 'clickhouse-server', 'clickhouse-client'];
const architectures = { x86_64: ['amd64', 'x86_64'], aarch64: ['arm64', 'aarch64'] };

function distribution(osRelease) {
  const requiredKeys = ['ID', 'ID_LIKE', 'VERSION_ID'];
  return Object.fromEntries(osRelease.split(/\r?\n/).flatMap(line => {
    const pair = /^([A-Z_]+)=["']?([a-zA-Z0-9._ -]+)["']?$/.exec(line);
    return pair && requiredKeys.includes(pair[1]) ? [[pair[1], pair[2]]] : [];
  }));
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function select({ platform, machine, osRelease = '', systemd = true }, format = 'auto') {
  if (!['linux', 'darwin'].includes(platform)) throw Error('不支持的运行系统: ' + platform);
  machine = { arm64: 'aarch64', x64: 'x86_64' }[machine] || machine;
  const architecture = architectures[machine];
  if (!architecture) throw Error('不支持的目标服务器架构: ' + machine);
  const [debArch, rpmArch] = architecture;
  if (platform === 'darwin') {
    if (!['auto', 'binary'].includes(format)) throw Error('包格式与 macOS 不匹配: ' + format);
    const name = machine === 'aarch64' ? 'clickhouse-macos-aarch64' : 'clickhouse-macos';
    const asset = release.assets[name];
    if (!asset) throw Error('固定发布清单缺少资产: ' + name);
    return { platform, machine, distribution: 'macos', format: 'binary', serviceManager: 'project',
      version: release.version, tag: release.tag, packageArchitecture: debArch,
      packages: [{ component: 'clickhouse', name, ...asset, url: repository + '/releases/download/' + release.tag + '/' + name }] };
  }
  const { ID = 'unknown', ID_LIKE = '', VERSION_ID = '' } = distribution(osRelease);
  const families = [ID, ...ID_LIKE.split(/\s+/)];
  const deb = families.some(id => ['debian', 'ubuntu'].includes(id));
  const rpm = families.some(id => ['rhel', 'fedora', 'centos', 'rocky', 'almalinux', 'ol', 'openeuler'].includes(id));
  if (format === 'auto') format = !systemd ? 'tgz' : deb ? 'deb' : rpm ? 'rpm' : '';
  if (!format) throw Error('无法识别发行版 ' + ID + ' 的包格式。请显式选择 --format tgz 或接入已有 ClickHouse');
  if (!['deb', 'rpm', 'tgz'].includes(format) || (format === 'deb' && !deb) || (format === 'rpm' && !rpm)) {
    throw Error('包格式与目标发行版不匹配: ' + ID + ' / ' + format);
  }
  if (!systemd && format !== 'tgz') throw Error('无 systemd 环境请使用 --format tgz');
  const suffix = format === 'deb' ? '_' + release.version + '_' + debArch + '.deb'
    : format === 'rpm' ? '-' + release.version + '.' + rpmArch + '.rpm'
    : '-' + release.version + '-' + debArch + '.tgz';
  const names = format === 'tgz' ? components.slice(0, 1) : components;
  const packages = names.map(component => {
    const name = component + suffix;
    const asset = release.assets[name];
    if (!asset) throw Error('固定发布清单缺少资产: ' + name);
    return { component, name, ...asset, url: repository + '/releases/download/' + release.tag + '/' + name };
  });
  return {
    platform, serviceManager: systemd ? 'systemd' : 'project', distribution: ID, distributionVersion: VERSION_ID, machine, format,
    packageArchitecture: format === 'rpm' ? rpmArch : debArch,
    version: release.version, tag: release.tag, packages,
  };
}

function nativeMachine(platform = os.platform(), machine = os.machine(), probe = spawnSync) {
  if (platform === 'darwin' && machine === 'x86_64') {
    const result = probe('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim() === '1') return 'aarch64';
  }
  return machine;
}

function target(format, { portable = false } = {}) {
  const platform = os.platform();
  return select({
    platform, machine: nativeMachine(), systemd: !portable && fs.existsSync('/run/systemd/system'),
    osRelease: platform === 'linux' && fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : '',
  }, format);
}

function regular(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw Error('预期普通文件: ' + file);
  return stat;
}

async function verified(file, asset) {
  return regular(file)?.size === asset.size && await digest(file) === asset.sha256;
}

function checkResponse({ status, range, count, offset, size }) {
  if (status === 200) return count > 0 && count <= size ? 'replace' : '';
  if (status !== 206) return '';
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
  if (!match) return '';
  const [, start, end, total] = match.map(Number);
  return start === offset && total === size && end >= start && end < total &&
    count > 0 && count <= end - start + 1 ? 'append' : '';
}

function fetchPart(url, api, part, body, offset, size) {
  const headers = body + '.headers';
  if (regular(headers)) fs.unlinkSync(headers);
  const args = ['-q', '--silent', '--show-error', '--location', '--max-redirs', '5',
    '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--http1.1',
    '--connect-timeout', '15', '--max-time', '300', '--speed-time', '30', '--speed-limit', '1024', '--max-filesize', String(size),
    '--output', body, '--dump-header', headers, '--write-out', '%{http_code}\n%{url_effective}'];
  if (offset) args.push('--range', String(offset) + '-');
  if (api) args.push('--header', 'Accept: application/octet-stream');
  const result = spawnSync('curl', [...args, url], { encoding: 'utf8' });
  if (result.error) throw Error('curl 无法运行: ' + result.error.code);
  const [status, effective] = result.stdout.split('\n');
  let range = '';
  if (regular(headers)) {
    const lastResponse = fs.readFileSync(headers, 'utf8').trim().split(/\r?\n\r?\n/).at(-1) || '';
    range = /^content-range:\s*([^\r\n]+)/im.exec(lastResponse)?.[1]?.trim() || '';
    fs.unlinkSync(headers);
  }
  const host = effective ? new URL(effective).hostname : '';
  const allowedHosts = ['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
  const count = regular(body)?.size || 0;
  if (allowedHosts.includes(host) && [0, 18, 28, 56, 92].includes(result.status)) {
    const action = checkResponse({ status: Number(status), range, count, offset, size });
    if (action === 'append') {
      const source = fs.openSync(body, 'r');
      const destination = fs.openSync(part, 'a', 0o600);
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        let bytes;
        while ((bytes = fs.readSync(source, buffer, 0, buffer.length, null)) > 0) {
          let written = 0;
          while (written < bytes) written += fs.writeSync(destination, buffer, written, bytes - written);
        }
      } finally {
        fs.closeSync(source);
        fs.closeSync(destination);
      }
    } else if (action === 'replace') fs.renameSync(body, part);
  }
  return 'HTTP ' + status + ', curl ' + result.status;
}

async function acquire(asset, cache, packageDir, download = fetchPart) {
  const file = path.join(cache, asset.name);
  if (await verified(file, asset)) return file;
  if (packageDir) {
    const source = path.join(packageDir, asset.name);
    // Copy first so a writable offline source cannot change between verification and installation.
    const staged = file + '.offline';
    if (regular(staged)) fs.unlinkSync(staged);
    try {
      if (regular(source)?.size !== asset.size) throw Error('离线正式包缺失或大小不符: ' + asset.name);
      fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
      if (!await verified(staged, asset)) throw Error('离线正式包 SHA-256 不符: ' + asset.name);
      fs.renameSync(staged, file);
      return file;
    } finally {
      if (regular(staged)) fs.unlinkSync(staged);
    }
  }
  const part = file + '.part';
  const body = file + '.transfer';
  const routes = [[asset.url, false], [assetApi + '/' + asset.id, true]];
  const outcomes = [];
  for (const [url, api] of routes) {
    if (await verified(part, asset)) break;
    if ((regular(part)?.size || 0) >= asset.size) fs.unlinkSync(part);
    if (regular(body)) fs.unlinkSync(body);
    const offset = regular(part)?.size || 0;
    console.log('[下载] ' + asset.name + ' · ' + (api ? 'Release Asset API' : '官方发布链接') + ' · ' + offset + '/' + asset.size);
    try { outcomes.push(download(url, api, part, body, offset, asset.size)); }
    finally { if (regular(body)) fs.unlinkSync(body); }
  }
  if (!await verified(part, asset)) {
    const count = regular(part)?.size || 0;
    const reason = count === asset.size ? 'SHA-256 不匹配' : '下载未完成，已保留可续传文件';
    throw Error(asset.name + ': ' + reason + ' (' + count + '/' + asset.size + '; ' + outcomes.join('; ') + ')。可使用 --package-dir 提供官方离线包');
  }
  fs.renameSync(part, file);
  return file;
}

module.exports = { acquire, select, target, nativeMachine, checkResponse, verified, digest };
