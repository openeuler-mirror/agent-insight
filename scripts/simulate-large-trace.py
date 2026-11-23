#!/usr/bin/env python3
"""Generate a resumable synthetic LLM trace through authenticated Storage Core HTTP."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def request(origin, path, token=None, body=None, headers=None):
    values = dict(headers or {})
    if token:
        values['Authorization'] = 'Bearer ' + token
    raw = None if body is None else json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
    if raw is not None:
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError('Batch exceeds 4 MiB; reduce --batch-size or --output-chars')
        values['Content-Type'] = 'application/json'
    req = urllib.request.Request(origin + path, data=raw, headers=values)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'{path.split("?")[0]} returned HTTP {exc.code}; run again with the same state file to resume') from None


def save(path, state):
    temp = path.with_name(path.name + '.tmp')
    with temp.open('w') as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
    temp.replace(path)


def attr(key, value):
    return {'key': key, 'value': {'intValue': str(value)} if isinstance(value, int) else {'stringValue': value}}


def make_span(state, index):
    root = index == 0
    start = state['start_ns'] + (0 if root else index * 10_000_000)
    end = state['start_ns'] + state['spans'] * 10_000_000 + 1_000_000_000 if root else start + 500_000_000
    seed = hashlib.sha256(f'{state["native_trace_id"]}:{index}'.encode()).hexdigest()
    sentence = f'Synthetic LLM response {index:05d}. Sample {seed}. This output is generated locally for ClickHouse performance testing. '
    output = (sentence * (state['output_chars'] // len(sentence) + 1))[:state['output_chars']]
    span = {'traceId': state['native_trace_id'], 'spanId': f'{index + 1:016x}',
            'name': 'synthetic-large-trace-root' if root else f'synthetic-llm-{index:05d}',
            'kind': 1 if root else 3, 'startTimeUnixNano': str(start), 'endTimeUnixNano': str(end),
            'status': {'code': 1}, 'attributes': [attr('test.synthetic', 'true')]}
    if not root:
        span['parentSpanId'] = '0000000000000001'
        span['attributes'] += [attr('gen_ai.system', 'synthetic'), attr('gen_ai.request.model', 'simulated-llm'),
                               attr('gen_ai.operation.name', 'chat'), attr('gen_ai.input', f'Simulate LLM response for item {index}.'),
                               attr('gen_ai.output', output), attr('gen_ai.usage.input_tokens', 16),
                               attr('gen_ai.usage.output_tokens', max(1, state['output_chars'] // 4))]
    return span


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--username', required=True)
    parser.add_argument('--web-url', default='http://127.0.0.1:3000')
    parser.add_argument('--core-url', default='http://127.0.0.1:4319')
    parser.add_argument('--state-file', type=Path, required=True, help='New file for a new trace; reuse to resume')
    parser.add_argument('--spans', type=int, default=21001, help='Includes one root span')
    parser.add_argument('--batch-size', type=int, default=500)
    parser.add_argument('--output-chars', type=int, default=1024)
    parser.add_argument('--index-timeout', type=int, default=600)
    args = parser.parse_args()
    if not 2 <= args.spans <= 100000 or not 1 <= args.batch_size <= 4096 or not 1 <= args.output_chars <= 65536 or args.index_timeout < 1:
        parser.error('Require 2..100000 spans, 1..4096 batch size, 1..65536 output chars and positive timeout')
    for url in (args.web_url, args.core_url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            parser.error('This standalone-login helper requires loopback HTTP origins')
    args.web_url = args.web_url.rstrip('/')
    args.core_url = args.core_url.rstrip('/')
    os.umask(0o077)
    spec = {key: getattr(args, key) for key in ('username', 'web_url', 'core_url', 'spans', 'batch_size', 'output_chars')}
    if args.state_file.exists():
        state = json.loads(args.state_file.read_text())
        if any(state.get(key) != value for key, value in spec.items()):
            raise ValueError('Resume arguments must match the state file')
    else:
        end_ns = time.time_ns() - 2_000_000_000
        duration = args.spans * 10_000_000 + 1_000_000_000
        day_ns = 86400 * 1_000_000_000
        if (end_ns - duration) // day_ns != end_ns // day_ns:
            end_ns = end_ns // day_ns * day_ns - 1_000_000_000
        state = dict(spec, version=1, native_trace_id=secrets.token_hex(16),
                     start_ns=end_ns - duration, completed=0, batches=[])
        args.state_file.parent.mkdir(parents=True, exist_ok=True)
        with args.state_file.open('x') as stream:
            json.dump(state, stream)
    login = request(args.web_url, '/api/auth/apikey', body={'username': args.username})
    if login.get('username') != args.username.lower():
        raise ValueError('Login returned a different user')
    token = login['apiKey']
    if not token.startswith('api_'):
        raise ValueError('Storage Core API credential required')
    profile = request(args.core_url, '/v1/auth/me', token)
    if profile.get('legacy_username', profile.get('username')) != args.username.lower():
        raise ValueError('Storage Core identity differs')
    workspace = profile['workspace_id']
    if state.get('principal_id', profile['principal_id']) != profile['principal_id'] or state.get('workspace_id', workspace) != workspace:
        raise ValueError('Resume identity differs')
    state.update(principal_id=profile['principal_id'], workspace_id=workspace)
    save(args.state_file, state)
    query = '?' + urllib.parse.urlencode({'workspace_id': workspace})
    for first in range(state['completed'], state['spans'], state['batch_size']):
        started = time.monotonic()
        last = min(first + state['batch_size'], state['spans'])
        packet = {'resourceSpans': [{'resource': {'attributes': [attr('service.name', 'synthetic-large-trace'),
                   attr('agent.name', 'Synthetic LLM Load Test'), attr('telemetry.sdk.name', 'synthetic'),
                   attr('agent_insight.source_namespace', 'synthetic.loadtest')]},
                   'scopeSpans': [{'scope': {'name': 'simulate-large-trace'}, 'spans': [make_span(state, i) for i in range(first, last)]}]}]}
        receipt = request(args.core_url, '/v1/ingest/otlp', token, packet,
                          {'X-Workspace-Id': workspace, 'Idempotency-Key': f'synthetic:{state["native_trace_id"]}:{first}'})
        trace_id = receipt['trace_ids'][0]
        if len(receipt['trace_ids']) != 1 or state.get('trace_id', trace_id) != trace_id:
            raise ValueError('Expected exactly one trace')
        state['trace_id'] = trace_id
        save(args.state_file, state)
        deadline = time.monotonic() + args.index_timeout
        while receipt['state'] != 'indexed':
            if receipt['state'] == 'failed' or time.monotonic() > deadline:
                raise RuntimeError(f'Batch {receipt["batch_id"]} state={receipt["state"]}; rerun with the same state file')
            time.sleep(1)
            receipt = request(args.core_url, '/v1/batches/' + receipt['batch_id'] + query, token)
        seconds = round(time.monotonic() - started, 3)
        state['completed'] = last
        state['batches'].append({'batch_id': receipt['batch_id'], 'spans': last - first, 'seconds': seconds})
        save(args.state_file, state)
        print(f'indexed {last}/{state["spans"]} spans; batch {seconds}s', flush=True)
    summary = request(args.core_url, '/v1/traces/' + state['trace_id'] + query, token)
    trace = summary['trace']
    if int(trace['span_count']) != state['spans'] or trace['owner_principal_id'] != state['principal_id']:
        raise ValueError('Indexed span count or owner differs')
    state['verified_span_count'] = int(trace['span_count'])
    span_path = '/v1/traces/' + state['trace_id'] + '/spans/' + f'{state["spans"]:016x}'
    span = request(args.core_url, span_path + query, token)['span']
    payload = request(args.core_url, span_path + '/payload' + query + '&' + urllib.parse.urlencode(
        {'revision': span['payload_revision'], 'section': 'output'}), token)
    output = ''.join(chunk['body'] for chunk in payload['chunks'])
    expected = next(a['value']['stringValue'] for a in make_span(state, state['spans'] - 1)['attributes'] if a['key'] == 'gen_ai.output')
    if not payload['complete'] or output != expected:
        raise ValueError('Last LLM output did not round-trip')
    state['verified_output_chars'] = len(output)
    state['trace_url'] = args.web_url + '/trace?' + urllib.parse.urlencode({'taskId': state['trace_id']})
    save(args.state_file, state)
    print(json.dumps({key: state[key] for key in ('trace_id', 'verified_span_count', 'trace_url')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)
