"""Research-only relaxed coverage LP with an independently checked integer dual certificate."""
import gzip
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_matrix

root, output = map(Path, sys.argv[1:3])
distribution = '--distribution' in sys.argv[3:]
names = [arg for arg in sys.argv[3:] if arg != '--distribution'] or ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat']
output.mkdir(parents=True, exist_ok=True)
reports = []
scale = 10**9
for name in names:
    raw = (root/f'{name}.json').read_bytes()
    data = json.loads(raw)
    groups, v = data['groups'], data['vocabulary']
    n = len(groups)
    rows, cols, values = [], [], []
    for i, g in enumerate(groups):
        rows.extend(g['terms']); cols.extend([i]*len(g['terms'])); values.extend([-1]*len(g['terms']))
    rows.extend(range(v)); cols.extend(range(n, n+v)); values.extend([1]*v)
    rows.extend([v]*n); cols.extend(range(n)); values.extend(g['cost'] for g in groups)
    rows.extend([v+1]*n); cols.extend(range(n)); values.extend([1]*n)
    dimensions = 0
    extra_b = []
    if distribution:
        labels = sorted(set(g['task'] for g in groups))
        partitions = [[g['bucket'] for g in groups], [labels.index(g['task']) for g in groups]]
        dimensions = 4+len(labels)
        row = v+2
        rows.extend([row]*n); cols.extend(range(n)); values.extend([-1]*n); extra_b.append(-data['k']); row += 1
        dimension = 0
        for partition, categories, threshold in zip(partitions, [4, len(labels)], [.1, .2]):
            auxiliary = []
            for category in range(categories):
                ids = [i for i, label in enumerate(partition) if label == category]
                variable = n+v+dimension; auxiliary.append(variable); dimension += 1
                for sign in [1, -1]:
                    rows.extend([row]*len(ids)); cols.extend(ids); values.extend([sign*n]*len(ids))
                    rows.append(row); cols.append(variable); values.append(-n)
                    extra_b.append(sign*data['k']*len(ids)); row += 1
            rows.extend([row]*len(auxiliary)); cols.extend(auxiliary); values.extend([1]*len(auxiliary))
            extra_b.append(round(2*data['k']*max(threshold, 2/data['k']))); row += 1
    a = coo_matrix((np.asarray(values, dtype=np.int64), (rows, cols)), shape=(v+2+len(extra_b), n+v+dimensions)).tocsr()
    b = np.asarray([0]*v+[data['budget'],data['k']]+extra_b, dtype=np.int64)
    c = np.zeros(n+v+dimensions); c[n:n+v] = -1
    upper = np.asarray([1]*(n+v)+[data['k']]*dimensions, dtype=np.int64)
    started = time.monotonic()
    result = linprog(c, A_ub=a, b_ub=b, bounds=np.column_stack((np.zeros(len(upper)), upper)), method='highs', options={'time_limit': 90})
    # Any nonnegative multiplier is valid; failed solves retain the trivial dictionary bound.
    dual = np.zeros(len(b), dtype=np.int64) if not result.success else np.rint(np.maximum(0, -result.ineqlin.marginals)*scale).astype(np.int64)
    assert np.all(dual >= 0)
    # Verify with Python integers rather than trusting solver tolerances or an int64 product.
    lhs = sum(int(x)*int(y) for x, y in zip(b, dual))
    matrix = a.tocsc()
    for column in range(matrix.shape[1]):
        residual = scale if n <= column < n+v else 0
        for index in range(matrix.indptr[column], matrix.indptr[column+1]):
            residual -= int(matrix.data[index])*int(dual[matrix.indices[index]])
        lhs += int(upper[column])*max(0, residual)
    trivial = min(v, sum(sorted((len(g['terms']) for g in groups), reverse=True)[:data['k']]))
    bound = min(trivial, lhs/scale)
    certificate = {'scale': scale, 'multipliers': dual.tolist(), 'numerator': lhs, 'inputSha256': hashlib.sha256(raw).hexdigest(), 'distribution': distribution, 'definition': 'max sum(y), y_t <= sum incident x_g, cost <= budget, x/y in [0,1]; distribution mode adds exactly K distinct inputs and original length/task TV; no task or behavior floors'}
    with gzip.GzipFile(filename=str(output/f'{name}-certificate.json.gz'), mode='wb', mtime=0) as handle:
        handle.write(json.dumps(certificate, separators=(',', ':')).encode())
    report = {k: data[k] for k in ['name', 'k', 'budget', 'vocabulary', 'sourceSha256', 'baselineSha256', 'poolSha256', 'exporterSha256']}
    report.update(groups=n, distribution=distribution, inputSha256=certificate['inputSha256'], solverSucceeded=bool(result.success), solverStatus=result.message, elapsedSeconds=time.monotonic()-started, relaxedObjective=-result.fun if result.success else None, integerCertificateBound=lhs/scale, upperBound=bound, verifiedWithPythonIntegers=True, solverSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    reports.append(report)
    (output/'summary.json').write_text(json.dumps(reports, indent=2))
    print(json.dumps({k: report[k] for k in ['name', 'solverSucceeded', 'upperBound', 'elapsedSeconds']}), flush=True)
