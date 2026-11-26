#!/usr/bin/env python3
"""Insert or resume the local 1,000-Trace pagination fixture through OTLP."""

import argparse
import json
from pathlib import Path
import re
import runpy
import secrets
import time
from urllib.error import URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, build_opener, install_opener
import uuid


ROOT = Path(__file__).resolve().parent.parent
WEB = 'http://127.0.0.1:3000'
CORE = 'http://127.0.0.1:4319'
USERNAME = 'trace-pagination-test-20261125'
LARGE_COUNT, LARGE_SPANS, LARGE_BATCH = 5, 20001, 1000
SMALL_COUNT, SMALL_SPANS, SMALL_BATCH = 995, 5, 40
OUTPUT_CHARS = 128
NS_PER_DAY = 86400 * 10**9

helpers = runpy.run_path(str(ROOT / 'scripts/simulate-large-trace.py'))
attr, make_span, send = (helpers[name] for name in ('attr', 'make_span', 'request'))


def request(origin, path, *values, **options):
    for attempt in range(12):
        try:
            return send(origin, path, *values, **options)
        except RuntimeError as error:
            if not re.search(r' HTTP (429|502|503|504);', str(error)) or attempt == 11:
                raise
        except (URLError, TimeoutError, ConnectionError):
            if attempt == 11:
                raise
        time.sleep(min(8, .5 * 2**attempt))


def native_id(run_id, index):
    return uuid.uuid5(uuid.NAMESPACE_URL, f'{run_id}:{index}').hex


def restore(config_path, principal, workspace, new):
    config = json.loads(config_path.read_text())['control']
    if config['backend'] != 'postgresql' or urlsplit(config['dsn']).hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('This fixture recovery requires the configured local PostgreSQL')
    import psycopg2
    from psycopg2 import sql

    with psycopg2.connect(config['dsn'], connect_timeout=5) as connection:
        connection.set_session(readonly=True)
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL('SET LOCAL search_path TO {}').format(sql.Identifier(config['schema'])))
            cursor.execute('SET LOCAL statement_timeout = 10000')
            cursor.execute(
                'SELECT receipt_key,state,packet_ref FROM ingest_batches '
                'WHERE workspace_id=%s AND principal_id=%s AND receipt_key LIKE %s',
                (workspace, principal, 'trace-pagination:%'),
            )
            receipts = cursor.fetchall()
    if new:
        if receipts:
            raise ValueError('Use a fresh test account with --new, or resume the existing fixture')
        end = time.time_ns() - 3 * 10**9
        duration = LARGE_SPANS * 10**7 + 10**9
        start = end - duration
        if (start - 1000 * 10**6) // NS_PER_DAY != end // NS_PER_DAY:
            start = end // NS_PER_DAY * NS_PER_DAY - duration - 10**9
        return secrets.token_hex(16), start, set()
    run_ids = {key.split(':')[1] for key, _, _ in receipts}
    if len(run_ids) != 1:
        raise ValueError('Expected one earlier fixture for this account. Use --new for an intentional new run.')
    run_id = run_ids.pop()
    root_ref = next(Path(ref) for key, _, ref in receipts if key == f'trace-pagination:{run_id}:0')
    artifact_dir = Path(config['artifacts']).expanduser().resolve()
    if root_ref.resolve().parent != artifact_dir:
        raise ValueError('Existing packet is outside the configured artifact directory')
    original = json.loads(json.loads(root_ref.read_text())['json'])
    root = original['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
    if root['traceId'] != native_id(run_id, 0) or root['spanId'] != '0000000000000001':
        raise ValueError('The first receipt does not match the fixture')
    indexed = {int(key.rsplit(':', 1)[1]) for key, state, _ in receipts if state == 'indexed'}
    return run_id, int(root['startTimeUnixNano']), indexed


def prepare_batches():
    for trace in range(LARGE_COUNT):
        for start in range(0, LARGE_SPANS, LARGE_BATCH):
            yield [(trace, start, min(start + LARGE_BATCH, LARGE_SPANS))]
    for first in range(LARGE_COUNT, LARGE_COUNT + SMALL_COUNT, SMALL_BATCH):
        yield [(trace, 0, SMALL_SPANS) for trace in range(first, min(first + SMALL_BATCH, LARGE_COUNT + SMALL_COUNT))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--username', default=USERNAME)
    parser.add_argument('--config', type=Path, default=ROOT / 'config/storage.local.json')
    parser.add_argument('--new', action='store_true', help='Start a fixture in a fresh test account')
    args = parser.parse_args()

    install_opener(build_opener(ProxyHandler({})))
    login = request(WEB, '/api/auth/apikey', body={'username': args.username})
    token = login['apiKey']
    profile = request(CORE, '/v1/auth/me', token)
    if login['username'] != args.username or profile.get('legacy_username', profile.get('username')) != args.username:
        raise ValueError('The local Web and Storage Core accounts disagree')
    principal, workspace = profile['principal_id'], profile['workspace_id']
    run_id, first_start, indexed = restore(args.config, principal, workspace, args.new)
    cases = [
        {
            'native_trace_id': native_id(run_id, index),
            'start_ns': first_start - index * 10**6,
            'spans': LARGE_SPANS if index < LARGE_COUNT else SMALL_SPANS,
            'output_chars': OUTPUT_CHARS,
        }
        for index in range(LARGE_COUNT + SMALL_COUNT)
    ]
    ids = [
        str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(
            [workspace, 'otlp', case['native_trace_id'], 1], separators=(',', ':'),
        )))
        for case in cases
    ]
    work = list(prepare_batches())
    split = next(i for i, group in enumerate(work) if group[0][0] == LARGE_COUNT)
    query = '?' + urlencode({'workspace_id': workspace})
    resource = {'attributes': [
        attr('service.name', 'synthetic-trace-pagination'),
        attr('agent.name', 'Synthetic Trace Pagination Test'),
        attr('telemetry.sdk.name', 'synthetic'),
        attr('agent_insight.source_namespace', 'otlp'),
    ]}
    print(f'{len(indexed)}/{len(work)} already indexed', flush=True)
    for batch_index in [0, *range(split, len(work)), *range(1, split)]:
        if batch_index in indexed:
            continue
        group = work[batch_index]
        spans = []
        for trace, start, end in group:
            for index in range(start, end):
                span = make_span(cases[trace], index)
                if index == 0:
                    span['name'] = f'trace-pagination-{trace+1:04d}-{cases[trace]["spans"]}-spans'
                spans.append(span)
        receipt = request(CORE, '/v1/ingest/otlp', token, {
            'resourceSpans': [{'resource': resource, 'scopeSpans': [{'scope': {'name': 'trace-pagination-fixture'}, 'spans': spans}]}],
        }, {'X-Workspace-Id': workspace, 'Idempotency-Key': f'trace-pagination:{run_id}:{batch_index}'})
        if set(receipt['trace_ids']) != {ids[trace] for trace, _, _ in group}:
            raise ValueError('An ingest receipt returned unexpected Trace IDs')
        deadline = time.monotonic() + 600
        while receipt['state'] != 'indexed':
            if receipt['state'] == 'failed' or time.monotonic() >= deadline:
                raise RuntimeError(f'Batch {batch_index + 1} is {receipt["state"]}')
            time.sleep(1)
            receipt = request(CORE, '/v1/batches/' + receipt['batch_id'] + query, token)
        indexed.add(batch_index)
        if len(indexed) % 5 == 0 or len(indexed) == len(work):
            print(f'{len(indexed)}/{len(work)} batches indexed', flush=True)

    expected = dict(zip(ids, (case['spans'] for case in cases)))
    verified = {}
    params = {'workspace_id': workspace, 'limit': 200}
    while True:
        result = request(CORE, '/v1/traces?' + urlencode(params), token)
        for row in result['items']:
            if row['trace_id'] in expected:
                if row['owner_principal_id'] != principal:
                    raise ValueError('A fixture Trace has the wrong owner')
                verified[row['trace_id']] = (int(row['span_count']), int(row['started_at_ms']))
        if len(verified) == len(expected) or not result.get('next_cursor'):
            break
        params['cursor'] = result['next_cursor']
    if {trace: count for trace, (count, _) in verified.items()} != expected:
        raise ValueError(f'Unexpected distribution in {len(verified)} indexed Traces')
    if sorted(verified, key=lambda trace: verified[trace][1], reverse=True)[:LARGE_COUNT] != ids[:LARGE_COUNT]:
        raise ValueError('The five large Traces do not sort first')
    print(json.dumps({
        'username': args.username, 'trace_count': len(verified), 'span_count': sum(expected.values()),
        'large_trace_urls': [WEB + '/trace?' + urlencode({'taskId': case['native_trace_id']}) for case in cases[:LARGE_COUNT]],
    }, indent=2), flush=True)


if __name__ == '__main__':
    main()
