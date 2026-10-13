"""Restore the exact published regression inputs from their frozen manifest."""
import concurrent.futures
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import urllib.parse

root = Path(sys.argv[1])
names = sys.argv[2:]
manifest = json.loads(Path('docs/design/trace-eval-dataset/examples/eight-datasets/data-manifest.json').read_text())
spec = importlib.util.spec_from_file_location('fetch_eight', Path(__file__).with_name('fetch-eight-datasets.py'))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
original_fetch = source.fetch
by_name = {entry['name']: entry for entry in manifest}
by_url = {f['url']: f for entry in manifest for f in entry['files']}


def fetch(url, destination):
    name = destination.parent.name
    entry = by_name[name]
    if destination.name == 'metadata.json':
        return json.dumps({'sha': entry['revision'], 'siblings': [{'rfilename': f['file'].split('/', 1)[1].replace('--', '/')} for f in entry['files']], 'cardData': {'license': entry['license']}}).encode()
    if destination.name == 'size.json':
        import re
        total = int(re.search(r'accessible rows=(\d+)', entry['selection']).group(1))
        return json.dumps({'size': {'splits': [{'split': 'train', 'num_rows': total}]}, 'partial': False}).encode()
    record = by_url[url]
    data = original_fetch(url, destination)
    assert hashlib.sha256(data).hexdigest() == record['sha256'], f'Frozen source changed: {record["file"]}'
    return data


source.fetch = fetch


def restore(entry):
    target = root / entry['file']
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == entry['sha256']:
        print(entry['name'], 'already verified', flush=True)
        return
    recovered = source.download(root, entry['name'])
    assert recovered['sha256'] == entry['sha256'], f'Mapped input changed: {entry["name"]}'
    print(entry['name'], 'mapped SHA matches frozen input', flush=True)


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(restore, [e for e in manifest if not names or e['name'] in names]))
