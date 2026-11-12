/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const pythonSetup = String.raw`
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote, urlsplit, urlunsplit

class SetupError(Exception):
    pass

def docker(args, cwd, data=None):
    try:
        result = subprocess.run(['docker', *args], cwd=cwd, input=data,
            capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError('Docker 命令不可用或执行超时，请检查 Docker 和 Compose v2。')
    if result.returncode:
        raise SetupError('Docker 命令执行失败；请在部署目录检查服务状态，配置备份已保留。')
    return result.stdout

def write_private(file, text, mode=0o600):
    fd, name = tempfile.mkstemp(prefix='.agent-insight-dify-', dir=file.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def env_quote(value):
    return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"

def main():
    supplied = os.environ.get('AGENT_INSIGHT_DIFY_DIR')
    working = Path(os.environ.get('AGENT_INSIGHT_DIFY_WORKING_DIR', os.getcwd()))
    candidates = [Path(supplied).expanduser()] if supplied else [working, working / 'docker']
    names = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']
    directory = next((p.resolve() for p in candidates if p.is_dir() and
        (any((p / name).is_file() for name in names) or os.environ.get('COMPOSE_FILE'))), None)
    if directory is None:
        raise SetupError('未找到 Dify Compose 部署。请进入 Dify 的 docker 目录，或设置 AGENT_INSIGHT_DIFY_DIR 后重试。特殊部署请参考 Dify 接入文档。')
    env_file = directory / '.env'
    if env_file.is_symlink() or not env_file.is_file() or os.environ.get('COMPOSE_ENV_FILES'):
        raise SetupError('自动配置需要部署目录中已有的普通 .env 文件；自定义环境文件请参考 Dify 接入文档。')
    endpoint = os.environ.get('AGENT_INSIGHT_DIFY_ENDPOINT', '').strip()
    key = os.environ.get('AGENT_INSIGHT_DIFY_API_KEY', '')
    parsed = urlsplit(endpoint)
    if not key or any(c in key for c in '\r\n\x00'):
        raise SetupError('Dify 接入需要有效的 Agent Insight API Key，请刷新安装页后重试。')
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or any(c in endpoint for c in '\r\n\x00'):
        raise SetupError('请输入不含凭据的完整 HTTP(S) OTLP Trace 上报地址。')
    if parsed.hostname in ('localhost', '127.0.0.1', '::1'):
        system = docker(['info', '--format', '{{.OperatingSystem}}'], directory)
        if 'desktop' not in system.lower():
            raise SetupError('容器不能使用宿主机的 localhost；请在安装页填写容器可达的上报地址，或设置 AGENT_INSIGHT_DIFY_ENDPOINT。')
        endpoint = urlunsplit((parsed.scheme, 'host.docker.internal' + (':' + str(parsed.port) if parsed.port else ''), parsed.path, '', ''))
        print('Docker Desktop: 使用 host.docker.internal 访问本机平台。')
    def configuration():
        return json.loads(docker(['compose', 'config', '--format', 'json'], directory))['services']
    services = configuration()
    workflow = [name for name, service in services.items() if
        'dify-api' in service.get('image', '').lower() and
        str((service.get('environment') or {}).get('MODE', name)) in ('api', 'worker')]
    if not any(str((services[n].get('environment') or {}).get('MODE', n)) == 'api' for n in workflow) or not any(str((services[n].get('environment') or {}).get('MODE', n)) == 'worker' for n in workflow):
        raise SetupError('未识别到 Dify API 和 Worker 服务，未修改配置；请参考 Dify 接入文档。')
    agents = [name for name, service in services.items() if
        'dify-agent' in service.get('image', '').lower() and 'sandbox' not in service.get('image', '').lower()]
    workflow_values = {
        'ENABLE_OTEL': 'true', 'OTEL_EXPORTER_OTLP_PROTOCOL': 'http',
        'OTLP_TRACE_ENDPOINT': endpoint, 'OTLP_API_KEY': '',
        'OTEL_EXPORTER_OTLP_TRACES_HEADERS': 'x-witty-api-key=' + quote(key, safe="~()*!.'-"),
        'OTEL_SAMPLING_RATE': '1.0',
    }
    agent_values = {
        'DIFY_AGENT_TRAJECTORY_ENABLED': 'true',
        'DIFY_AGENT_TRAJECTORY_OTLP_TRACES_ENDPOINT': endpoint,
        'DIFY_AGENT_TRAJECTORY_OTLP_HEADERS': json.dumps({'x-witty-api-key': key}),
        'DIFY_AGENT_TRAJECTORY_INCLUDE_CONTENT': 'true',
    }
    values = {**workflow_values, **(agent_values if agents else {})}
    compose_environment = dict(line.split('=', 1) for line in
        docker(['compose', 'config', '--environment'], directory).splitlines() if '=' in line)
    separator = compose_environment.get('COMPOSE_PATH_SEPARATOR') or os.pathsep
    compose_files = [name for name in compose_environment.get('COMPOSE_FILE', '').split(separator) if name]
    if not compose_files:
        compose_files = [next(name for name in names if (directory / name).is_file())]
        overrides = ['compose.override.yml', 'compose.override.yaml', 'docker-compose.override.yml', 'docker-compose.override.yaml']
        existing_override = next((name for name in overrides if (directory / name).is_file()), None)
        if existing_override:
            compose_files.append(existing_override)
    override_file = directory / 'compose.agent-insight.yaml'
    managed = any((directory / name).resolve() == override_file.resolve() for name in compose_files)
    needs_override = managed or any('OTEL_EXPORTER_OTLP_TRACES_HEADERS' not in
        (services[name].get('environment') or {}) for name in workflow)
    previous_override = None
    override_mode = 0o600
    override_changed = False
    override_content = None
    if needs_override:
        if os.environ.get('COMPOSE_FILE') and not managed:
            raise SetupError('当前终端设置了 COMPOSE_FILE；请将 compose.agent-insight.yaml 加入文件列表后重试，或参考 Dify 接入文档。')
        if override_file.is_symlink() or (override_file.exists() and not override_file.is_file()):
            raise SetupError('compose.agent-insight.yaml 不是普通文件，未修改配置。')
        if override_file.exists():
            previous_override = override_file.read_text()
            override_mode = override_file.stat().st_mode & 0o777
            try:
                owned = json.loads(previous_override).get('x-agent-insight-managed') == 1
            except (ValueError, AttributeError):
                owned = False
            if not owned:
                raise SetupError('compose.agent-insight.yaml 已存在且不属于安装脚本，未修改配置。')
        override_content = json.dumps({'x-agent-insight-managed': 1, 'services': {
            name: {'environment': {'OTEL_EXPORTER_OTLP_TRACES_HEADERS': '$' + '{OTEL_EXPORTER_OTLP_TRACES_HEADERS}'}}
            for name in workflow}}, indent=2) + '\n'
        override_changed = override_content != previous_override
        if not managed:
            compose_files.append(override_file.name)
        values['COMPOSE_FILE'] = separator.join(compose_files)
    original = env_file.read_text()
    original_mode = env_file.stat().st_mode & 0o777
    start = '# >>> Agent Insight Dify OTLP >>>'
    end = '# <<< Agent Insight Dify OTLP <<<'
    block = start + '\n' + '\n'.join(k + '=' + env_quote(v) for k, v in values.items()) + '\n' + end
    if start in original:
        if original.count(start) != 1 or original.count(end) != 1 or original.index(end) < original.index(start):
            raise SetupError('已有 Agent Insight 配置块不完整，请检查 .env 后重试。')
        updated = re.sub(re.escape(start) + r'.*?' + re.escape(end), lambda _: block, original, flags=re.S)
    else:
        updated = original + ('\n' if original and not original.endswith('\n') else '') + '\n' + block + '\n'
    changed = updated != original
    if changed:
        backup = directory / ('.env.agent-insight-backup-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S%f'))
        with open(backup, 'x') as stream:
            os.chmod(backup, 0o600)
            stream.write(original)
        write_private(env_file, updated)
        print('配置备份：' + str(backup))
    try:
        if override_changed:
            write_private(override_file, override_content)
        rendered = configuration()
        for name in workflow + agents:
            expected = workflow_values if name in workflow else agent_values
            actual = {k: v.replace('$$', '$') if isinstance(v, str) else v
                for k, v in (rendered[name].get('environment') or {}).items()}
            if any(str(actual.get(k, '')).lower() != v.lower() if v in ('true', 'false') else str(actual.get(k, '')) != v for k, v in expected.items()):
                raise SetupError('Compose 未将 OTLP 配置注入 ' + name + '；已恢复原环境文件，请参考 Dify 接入文档。')
    except Exception:
        if changed:
            write_private(env_file, original, original_mode)
        if override_changed:
            if previous_override is None:
                override_file.unlink(missing_ok=True)
            else:
                write_private(override_file, previous_override, override_mode)
        raise
    selected = workflow + agents
    print('重新加载服务：' + ', '.join(selected))
    docker(['compose', 'up', '-d', '--no-deps', *selected], directory)
    for name in selected:
        ids = docker(['compose', 'ps', '-q', name], directory).split()
        if not ids:
            raise SetupError('服务未启动：' + name)
        for container in ids:
            info = json.loads(docker(['inspect', container], directory))[0]
            actual = dict(item.split('=', 1) for item in info.get('Config', {}).get('Env', []) if '=' in item)
            expected = workflow_values if name in workflow else agent_values
            if not info.get('State', {}).get('Running') or any(actual.get(k) != v for k, v in expected.items()):
                raise SetupError('容器中的 OTLP 配置未生效：' + name + '；请检查服务状态。')
    probe = "import json,sys,urllib.request; c=json.load(sys.stdin); r=urllib.request.urlopen(urllib.request.Request(c['endpoint'],data=b'{\"resourceSpans\":[]}',headers={'Content-Type':'application/json','x-witty-api-key':c['key']}),timeout=10); result=json.load(r); assert result.get('status')=='accepted'"
    for name in [*workflow, *agents]:
        docker(['compose', 'exec', '-T', name, 'python3', '-c', probe], directory,
            json.dumps({'endpoint': endpoint, 'key': key}))
    print('Dify 接入配置已生效；容器到接收端的鉴权与连接检查通过。')
    if not agents:
        print('未发现原生 Agent 运行服务，本次仅配置 Workflow；Agent 内部轨迹请在运行服务部署后再次执行。')
    print('请在 Dify 运行一个任务，再到 Agent Insight 链路追踪中验证实际模型与工具数据。')

try:
    main()
except SetupError as error:
    print('Dify 配置失败：' + str(error), file=sys.stderr)
    sys.exit(1)
except Exception:
    print('Dify 配置失败，请检查部署文件、Docker 状态及上报地址；未输出任何密钥。', file=sys.stderr)
    sys.exit(1)
`;

export const DIFY_BASH_SETUP_FUNCTION = [
  'agent_insight_setup_dify() {',
  '  if ! command -v python3 >/dev/null 2>&1; then echo "Dify 配置需要 Python 3" >&2; return 1; fi',
  '  AGENT_INSIGHT_DIFY_WORKING_DIR="${SETUP_WORKING_DIR:-$PWD}" AGENT_INSIGHT_DIFY_ENDPOINT="${AGENT_INSIGHT_DIFY_ENDPOINT:-$1/api/ingest/otel/v1/traces}" AGENT_INSIGHT_DIFY_API_KEY="$2" python3 - <<\'AGENT_INSIGHT_DIFY_PY\'',
  pythonSetup,
  'AGENT_INSIGHT_DIFY_PY',
  '}',
].join('\n');

export const DIFY_WINDOWS_SETUP = "throw 'Dify 自动配置请在 Dify 部署的 Linux/macOS 主机或 WSL 中运行 curl 命令。'";

export function difySetupScript(baseUrl: string, apiKey: string, platform: 'unix' | 'windows') {
  if (platform === 'windows') return DIFY_WINDOWS_SETUP;
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return ['#!/bin/bash', 'set -e', DIFY_BASH_SETUP_FUNCTION,
    `agent_insight_setup_dify ${quote(baseUrl.replace(/\/+$/, ''))} ${quote(apiKey)}`,
  ].join('\n');
}
