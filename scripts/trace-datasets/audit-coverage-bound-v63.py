"""Check saved LP dual certificates without importing SciPy or sharing matrix construction."""
import gzip
import hashlib
import itertools
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
checks = []
for destination in map(Path, sys.argv[2:]):
    reports = json.loads((destination/'summary.json').read_text())
    for report in reports:
        name = report['name']
        raw = (root/f'{name}.json').read_bytes()
        data = json.loads(raw)
        cert = json.loads(gzip.decompress((destination/f'{name}-certificate.json.gz').read_bytes()))
        assert hashlib.sha256(raw).hexdigest() == cert['inputSha256'] == report['inputSha256']
        groups, v, k = data['groups'], data['vocabulary'], data['k']
        n, scale, dual = len(groups), cert['scale'], cert['multipliers']
        assert all(isinstance(d, int) and d >= 0 for d in dual)
        constant = data['budget']*dual[v] + k*dual[v+1]
        residual = [sum(dual[t] for t in g['terms']) - g['cost']*dual[v] - dual[v+1] for g in groups]
        auxiliary = 0
        if cert['distribution']:
            cursor = v+2
            constant -= k*dual[cursor]
            residual = [r+dual[cursor] for r in residual]; cursor += 1
            labels = sorted(set(g['task'] for g in groups))
            for key, categories, threshold in [('bucket', range(4), .1), ('task', labels, .2)]:
                categories = list(categories)
                sum_price = dual[cursor+2*len(categories)]
                for category in categories:
                    positive, negative = dual[cursor:cursor+2]; cursor += 2
                    ids = [i for i, g in enumerate(groups) if g[key] == category]
                    constant += k*len(ids)*(positive-negative)
                    for i in ids: residual[i] -= n*(positive-negative)
                    auxiliary += k*max(0, n*(positive+negative)-sum_price)
                constant += round(2*k*max(threshold, 2/k))*sum_price
                cursor += 1
            assert cursor == len(dual)
        else:
            assert len(dual) == v+2
        numerator = constant + sum(max(0, r) for r in residual) + sum(max(0, scale-d) for d in dual[:v]) + auxiliary
        assert numerator == cert['numerator']
        trivial = min(v, sum(sorted((len(g['terms']) for g in groups), reverse=True)[:k]))
        bound = min(trivial, numerator/scale)
        assert abs(bound-report['upperBound']) < 1e-8
        if n <= 12:
            best = 0
            for ids in itertools.combinations(range(n), k):
                selected = [groups[i] for i in ids]
                if sum(g['cost'] for g in selected) > data['budget']: continue
                if cert['distribution']:
                    ok = True
                    for key, threshold in [('bucket', .1), ('task', .2)]:
                        categories = set(g[key] for g in groups)
                        tv = sum(abs(sum(g[key] == c for g in selected)/k - sum(g[key] == c for g in groups)/n) for c in categories)/2
                        ok &= tv <= max(threshold, 2/k)+1e-9
                    if not ok: continue
                best = max(best, len({t for g in selected for t in g['terms']}))
            assert best <= bound+1e-9
        checks.append({'dataset': name, 'distribution': cert['distribution'], 'upperBound': bound, 'exactNumerator': numerator})
result = {'passed': True, 'certificates': len(checks), 'checks': checks, 'auditorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
print(json.dumps(result, indent=2))
