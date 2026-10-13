"""Fetch frozen public research inputs; never reads or writes the application database."""
import argparse
import concurrent.futures
import datetime
import gzip
import hashlib
import json
import math
import pathlib
import random
import time
import urllib.parse

import requests

REPOS = {
    'WildChat': 'allenai/WildChat',
    'Dolly': 'databricks/databricks-dolly-15k',
    'NoRobots': 'HuggingFaceH4/no_robots',
    'OASST2': 'OpenAssistant/oasst2',
    'ShareGPT4': 'openchat/openchat_sharegpt4_dataset',
    'UltraChat': 'openbmb/UltraChat',
    'HelpSteer2': 'nvidia/HelpSteer2',
    'SummarizeFeedback': 'openai/summarize_from_feedback',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, destination):
    if destination.exists():
        return destination.read_bytes()
    for attempt in range(8):
        try:
            response = requests.get(url, timeout=(20, 90))
            response.raise_for_status()
            data = response.content
            tmp = destination.with_suffix(destination.suffix + '.tmp')
            tmp.write_bytes(data)
            tmp.replace(destination)
            return data
        except requests.RequestException as error:
            if attempt == 7:
                raise
            response = getattr(error, 'response', None)
            if response is not None and response.status_code == 429:
                delay = max(60, int(response.headers.get('Retry-After', '60')) if response.headers.get('Retry-After', '60').isdigit() else 60)
                print(f'Rate limited: retry in {delay}s ({destination.name})', flush=True)
            else:
                delay = min(15, 2 ** attempt)
            time.sleep(delay)


def json_bytes(data):
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()


def row_pair(prompt, answer, group, row_id, **metadata):
    return {'input': prompt, 'reference_output': answer, 'group': str(group), 'rowId': str(row_id), **metadata}


def numeric_rating(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def first_pair(messages):
    for i, message in enumerate(messages):
        if message.get('role', message.get('from')) in ('user', 'human', 'prompter'):
            if i + 1 < len(messages) and messages[i + 1].get('role', messages[i + 1].get('from')) in ('assistant', 'gpt'):
                answer = messages[i + 1]
                return message.get('content', message.get('value', '')), answer.get('content', answer.get('value', ''))
            break
    return None


def download(root, name):
    repo = REPOS[name]
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(fetch('https://huggingface.co/api/datasets/' + repo, directory / 'metadata.json'))
    revision = metadata['sha']
    files = []
    excluded = {}
    raw_count = 0
    rows = []

    def source_file(filename, url=None):
        url = url or f'https://huggingface.co/datasets/{repo}/resolve/{revision}/{filename}?download=true'
        target = directory / filename.replace('/', '--')
        data = fetch(url, target)
        files.append({'file': str(target.relative_to(root)), 'url': url, 'sha256': digest(data), 'bytes': len(data)})
        return data

    def skip(reason):
        excluded[reason] = excluded.get(reason, 0) + 1

    selection = 'all rows from the named official training split'
    if name in ('WildChat', 'UltraChat'):
        size = json.loads(fetch('https://datasets-server.huggingface.co/size?dataset=' + repo, directory / 'size.json'))
        size_split = next(s for s in size['size']['splits'] if s['split'] == 'train')
        total = size_split['num_rows']
        page_count = math.ceil(total / 100)
        pages = sorted(random.Random(20261011).sample(range(page_count), min(120, page_count)))
        selection = f'120 uniformly sampled pages of up to 100 rows; seed 20261011; viewer accessible rows={total}; partial={size.get("partial")}'

        def page(index):
            params = {'dataset': repo, 'config': 'default', 'split': 'train', 'offset': index * 100, 'length': min(100, total - index * 100)}
            url = 'https://datasets-server.huggingface.co/rows?' + urllib.parse.urlencode(params)
            target = directory / f'page-{index}.json'
            data = fetch(url, target)
            value = json.loads(data)
            if value.get('truncated') or any(r.get('truncated_cells') for r in value['rows']):
                raise RuntimeError(f'{name}: truncated public rows at page {index}; refusing partial text')
            return value['rows'], {'file': str(target.relative_to(root)), 'url': url, 'sha256': digest(data), 'bytes': len(data)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            for index, (batch, record) in enumerate(pool.map(page, pages)):
                files.append(record)
                raw_count += len(batch)
                for entry in batch:
                    row = entry['row']
                    if name == 'WildChat':
                        pair = first_pair(row.get('conversation', []))
                        group = row.get('conversation_id', row.get('conversation_hash', str(entry['row_idx'])))
                        language = row.get('language', 'unknown')
                    else:
                        conversation = row.get('data', [])
                        pair = (conversation[0], conversation[1]) if len(conversation) >= 2 else None
                        group = row.get('id', entry['row_idx'])
                        language = 'English'
                    if pair:
                        rows.append(row_pair(*pair, group, entry['row_idx'], language=language))
                    else:
                        skip('no_first_user_assistant_pair')
                if (index + 1) % 20 == 0:
                    print(f'{name}: {index+1}/{len(pages)} pages', flush=True)
        current = requests.get('https://huggingface.co/api/datasets/' + repo, timeout=45)
        current.raise_for_status()
        if current.json()['sha'] != revision:
            raise RuntimeError(f'{name} repository changed during viewer collection')
        selection += '; viewer revision not pin-able: repository SHA checked before/after, exact response hashes frozen'
    elif name == 'Dolly':
        raw = [json.loads(line) for line in source_file('databricks-dolly-15k.jsonl').splitlines() if line]
        raw_count = len(raw)
        for i, row in enumerate(raw):
            prompt = row['instruction'] + ('\n\n' + row['context'] if row['context'] else '')
            rows.append(row_pair(prompt, row['response'], digest(prompt.encode()), i, category=row['category'], language='English'))
    elif name in ('NoRobots', 'OASST2'):
        import pyarrow.parquet as pq
        import pyarrow as pa
        filename = next(f['rfilename'] for f in metadata['siblings'] if f['rfilename'].startswith('data/train-') and f['rfilename'].endswith('.parquet'))
        raw = pq.read_table(pa.BufferReader(source_file(filename))).to_pylist()
        raw_count = len(raw)
        if name == 'NoRobots':
            for i, row in enumerate(raw):
                pair = first_pair(row['messages'])
                if pair:
                    rows.append(row_pair(*pair, row['prompt_id'], i, category=row['category'], language='English'))
                else:
                    skip('no_first_user_assistant_pair')
        else:
            by_id = {r['message_id']: r for r in raw}
            for row in raw:
                if row['role'] != 'assistant':
                    continue
                parent = by_id.get(row['parent_id'])
                if not parent or parent['role'] != 'prompter' or parent['parent_id'] is not None:
                    skip('not_root_prompt_direct_answer')
                    continue
                if row.get('deleted') or parent.get('deleted'):
                    skip('deleted_message')
                    continue
                labels = row.get('labels') or {}
                if isinstance(labels, dict):
                    labels = [{'name': n, 'value': v} for n, v in zip(labels.get('name', []), labels.get('value', []))]
                quality = {v['name']: v['value'] for v in labels if v['name'] == 'quality' and isinstance(v['value'], (int, float))}
                rows.append(row_pair(parent['text'], row['text'], row['message_tree_id'], row['message_id'], language=row['lang'], quality=quality))
            selection += '; direct assistant children of root prompts; quality is held out from selection'
    elif name == 'ShareGPT4':
        raw = json.loads(source_file('sharegpt_gpt4.json'))
        raw_count = len(raw)
        selection = 'complete sharegpt_gpt4.json from OpenChat; approximate same-name source, Microsoft exact snapshot unknown'
        for i, row in enumerate(raw):
            pair = first_pair(row.get('conversations', row.get('items', [])))
            if pair:
                rows.append(row_pair(*pair, row.get('id', i), i, language='unknown'))
            else:
                skip('no_first_user_assistant_pair')
    elif name == 'HelpSteer2':
        raw = [json.loads(line) for line in gzip.decompress(source_file('train.jsonl.gz')).splitlines() if line]
        raw_count = len(raw)
        for i, row in enumerate(raw):
            quality = {k: row[k] for k in ('helpfulness', 'correctness', 'coherence', 'complexity', 'verbosity')}
            rows.append(row_pair(row['prompt'], row['response'], digest(row['prompt'].encode()), i, language='English', quality=quality))
    else:
        selection = 'all five official axis_evals files; original split and TLDR/CNN-DM domain kept as separate pools; no comparisons-choice substitution'
        for filename in ('cnndm1.json', 'cnndm3.json', 'cnndm4.json', 'tldraxis1.json', 'tldraxis2.json'):
            url = 'https://openaipublic.blob.core.windows.net/summarize-from-feedback/dataset/axis_evals/' + filename
            raw = [json.loads(line) for line in source_file(filename, url).splitlines() if line]
            raw_count += len(raw)
            for i, row in enumerate(raw):
                info, summary = row['info'], row['summary']
                body = info.get('article') or info.get('post') or ''
                domain = 'CNN-DM' if 'article' in info else 'TLDR'
                prompt = 'Summarize the following article:\n\n' + (info.get('title', '') + '\n\n' if info.get('title') else '') + body
                quality = {k: score for k, value in summary.get('axes', {}).items() if (score := numeric_rating(value)) is not None}
                rows.append(row_pair(prompt, summary['text'], info['id'], f'{filename}:{i}', language='English', quality=quality, domain=domain, split=row['split']))
    content = json_bytes(rows)
    output = root / (name + '.json')
    output.write_bytes(content)
    entry = {'name': name, 'repo': repo, 'revision': revision, 'license': metadata.get('cardData', {}).get('license', 'not specified in HF card; see original publisher terms'), 'source': 'https://huggingface.co/datasets/' + repo, 'selection': selection, 'rawRows': raw_count, 'mappedRows': len(rows), 'mappingExclusions': excluded, 'file': output.name, 'sha256': digest(content), 'date': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mapping': 'public-first-turn-v2', 'files': files}
    (directory / 'manifest.json').write_text(json.dumps(entry, ensure_ascii=False, indent=2))
    print(f'{name}: complete raw={raw_count} mapped={len(rows)}', flush=True)
    return entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=pathlib.Path)
    parser.add_argument('--datasets', nargs='+', choices=REPOS, default=list(REPOS))
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    results, failures = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(download, args.directory, name): name for name in args.datasets}
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                results.append(future.result())
            except Exception as error:
                failures.append({'name': name, 'error': str(error)})
                print(f'{name}: FAILED {error}', flush=True)
    # Merge resumed datasets without dropping already completed manifests.
    results = [json.loads(p.read_text()) for p in sorted(args.directory.glob('*/manifest.json'))]
    (args.directory / 'manifest.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    (args.directory / 'fetch-status.json').write_text(json.dumps({'completed': [r['name'] for r in results], 'failures': failures}, ensure_ascii=False, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
