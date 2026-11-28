"""Compose independent services into a single persistent Agent Insight instance."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
from deployment_ini import DEFAULT_INI, PASSWORD, SERVICE, read_app_config
from urllib.request import urlopen

TEMPLATES = Path(__file__).resolve().parents[1] / 'deploy/docker'
BACKENDS = ('postgresql', 'opengauss', 'sqlite')
OPTIONS = ('WEB_HOST_PORT', 'PG_HOST_PORT', 'OG_HOST_PORT', 'SQLITE_HOST_PORT', 'CH_HOST_PORT',
           'WEB_BIND_ADDRESS', 'DB_BIND_ADDRESS', 'APP_IMAGE', 'OPENGAUSS_IMAGE', 'SQLITE_SERVICE_IMAGE')


def private_json(file):
    mode = file.lstat().st_mode
    if not stat.S_ISREG(mode) or mode & 0o077:
        raise ValueError(f'{file} 必须是 0600 的普通文件')
    return json.loads(file.read_text())


def publish(file, value, *, replace=False):
    with tempfile.NamedTemporaryFile(mode='w', dir=file.parent, delete=False) as out:
        try:
            json.dump(value, out, indent=2)
            out.flush()
            os.fsync(out.fileno())
            if replace:
                os.replace(out.name, file)
            else:
                os.link(out.name, file)
        finally:
            Path(out.name).unlink(missing_ok=True)


def project_volumes(project):
    return subprocess.check_output(['docker', 'volume', 'ls', '-q', '--filter',
                                    f'label=com.docker.compose.project={project}'], text=True).split()


def remember_volumes(directory, project):
    publish(directory / 'volumes.json', sorted(project_volumes(project)), replace=True)


def official_opengauss():
    image = 'opengauss:7.0.0-RC3'
    if subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return image
    arch = subprocess.check_output(['docker', 'version', '--format', '{{.Server.Arch}}'], text=True).strip()
    packages = {'arm64': ('arm', 'aarch64'), 'amd64': ('x86', 'x86_64')}
    if arch not in packages:
        raise ValueError(f'openGauss 未提供 {arch} 的默认归档，请用 OPENGAUSS_IMAGE 指定兼容镜像')
    folder, suffix = packages[arch]
    url = ('https://opengauss.obs.cn-south-1.myhuaweicloud.com/7.0.0-RC3/'
           f'openEuler22.03/{folder}/openGauss-Docker-7.0.0-RC3-{suffix}.tar')
    print(f'正在获取 openGauss 官方镜像 {image}（{arch}）', flush=True)
    with tempfile.TemporaryFile() as archive, urlopen(url, timeout=90) as response:
        shutil.copyfileobj(response, archive, length=1024 * 1024)
        archive.seek(0)
        subprocess.run(['docker', 'load'], stdin=archive, check=True)
    subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, check=True)
    return image


def settings(directory, project, selected):
    record = directory / 'instance.json'
    config = directory / 'storage.json'
    if record.exists():
        data = private_json(record)
        if selected and selected != data['backend']:
            raise ValueError('已有实例使用其他事务库，请迁移或指定新的 --instance-dir')
    else:
        if project_volumes(project) or config.exists():
            raise ValueError('已有配置或数据卷，请恢复 instance.json')
        backend = selected or 'postgresql'
        data = {'backend': backend, 'environment': {
            PASSWORD[backend]: 'Aa9-' + secrets.token_hex(14) if backend == 'opengauss' else secrets.token_hex(32),
            'CLICKHOUSE_PASSWORD': secrets.token_hex(32),
            **{key: os.environ[key] for key in OPTIONS if key in os.environ}}}
        publish(record, data)
    return data


def main():
    parser = argparse.ArgumentParser(description='Docker 数据库与项目分离部署')
    parser.add_argument('action', choices=['up', 'db', 'app', 'status', 'stop'])
    parser.add_argument('--transaction', choices=BACKENDS)
    parser.add_argument('--service', choices=['clickhouse', 'transaction'], help='db 阶段只启动选定的数据库服务')
    parser.add_argument('--instance-dir', type=Path, default=Path.home() / '.agent-insight-docker')
    parser.add_argument('--config', type=Path, help='单独启动项目时指定 INI 或旧版私有 JSON')
    parser.add_argument('--build', action='store_true', help='重新构建本地应用或 SQLite 镜像')
    args = parser.parse_args()
    if args.service and args.action != 'db':
        parser.error('--service 仅用于 db')
    if args.config and args.action != 'app' or args.action == 'app' and args.transaction:
        parser.error('--config 仅用于 app；app 从 JSON 读取事务库类型')
    if args.action == 'app' and args.config:
        config = args.config.expanduser().absolute()
        if not config.exists():
            parser.error(f'缺少 {config}，请填写事务库和 ClickHouse 配置')
        if config.suffix.lower() != '.ini':
            private_json(config)
    home = args.instance_dir.expanduser().resolve()
    project = 'insight-' + hashlib.sha256(str(home).encode()).hexdigest()[:12]
    os.umask(0o077)
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (home / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        compose = ['docker', 'compose', '-p', project]
        env = os.environ.copy()
        def run(*args):
            subprocess.run([*compose, *args], env=env, check=True)
        if args.action in ('stop', 'status'):
            # Only operate on this project's containers, including externally configured app-only instances.
            if args.action == 'status':
                subprocess.run(['docker', 'ps', '-a', '--filter', f'label=com.docker.compose.project={project}'], check=True)
            else:
                ids = subprocess.check_output(['docker', 'ps', '-q', '--filter', f'label=com.docker.compose.project={project}'], text=True).split()
                if ids:
                    subprocess.run(['docker', 'stop', *ids], check=True)
            return
        receipt = home / 'volumes.json'
        if receipt.exists() and not set(private_json(receipt)).issubset(project_volumes(project)):
            raise ValueError('已有数据卷缺失，请先恢复原实例备份')
        record = home / 'instance.json'
        options = ['-d', '--wait', '--wait-timeout', '300']
        if args.build:
            options.append('--build')
        if args.action in ('db', 'up'):
            data = settings(home, project, args.transaction)
            backend = data['backend']
            for key in OPTIONS:
                env.pop(key, None)
            env.update(data['environment'])
            services = [backend, 'clickhouse']
            if args.service:
                services = [backend if args.service == 'transaction' else 'clickhouse']
            if 'opengauss' in services and not env.get('OPENGAUSS_IMAGE'):
                env['OPENGAUSS_IMAGE'] = official_opengauss()
            for service in services:
                compose.extend(['-f', str(TEMPLATES / f'compose.{service}.yml')])
            run('up', *options, *(SERVICE.get(service, service) for service in services))
            remember_volumes(home, project)
            if args.action == 'db':
                print(f'数据库已就绪，实例 {project}')
                return
        else:
            data = private_json(record) if record.exists() else None
        if data:
            for key in ('APP_IMAGE', 'WEB_HOST_PORT', 'WEB_BIND_ADDRESS'):
                if key in data['environment']:
                    env.setdefault(key, data['environment'][key])
        source = config if args.config else DEFAULT_INI
        if source.suffix.lower() == '.ini':
            effective = read_app_config(source, data)
            config = home / 'app-storage.json'
            if not config.exists() or private_json(config) != effective:
                publish(config, effective, replace=True)
        env['STORAGE_CONFIG'] = str(config)
        info = config.stat()
        env['APP_CONFIG_REVISION'] = f'{info.st_ino}-{info.st_mtime_ns}'
        compose.extend(['-f', str(TEMPLATES / 'compose.app.yml')])
        try:
            run('up', *options, 'app')
        except subprocess.CalledProcessError:
            print(f'检查 {source} 的事务库 host/port/user/password（SQLite 为 endpoint/token）'
                  '和 [clickhouse] endpoint/user/password', file=sys.stderr)
            run('logs', '--tail=25', 'app')
            raise
        remember_volumes(home, project)
        print(f"Web 就绪 http://{env.get('WEB_BIND_ADDRESS', '127.0.0.1')}:{env.get('WEB_HOST_PORT', '3000')}")
        print(f'实例 {project}，配置 {source}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        sys.exit(f'部署失败：{exc}')
