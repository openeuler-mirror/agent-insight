import json
import statistics
import sys

source = json.load(open(sys.argv[1], encoding='utf8'))
result = {key: source[key] for key in ('policy', 'signatureSeed', 'selectionSeeds', 'limitation', 'peakRss')}
result['sources'] = []
for dataset in source['sources']:
    entry = {key: value for key, value in dataset.items() if key != 'experiments'}
    entry['holdout'] = []
    for k in (20, 50, 100, 200, 500):
        trials = [trial for trial in dataset['experiments'] if trial['split'] == 'holdout' and trial['k'] == k]
        methods = {}
        for method in ('B0', 'B1', 'B2', 'B3', 'B4'):
            values = [trial['methods'][method] for trial in trials]
            methods[method] = {key: {'mean': statistics.mean(value[key] for value in values), 'min': min(value[key] for value in values), 'max': max(value[key] for value in values)} for key in ('count', 'independentInputs', 'lexical3gramCoverage', 'taskTypes', 'nativeCategories', 'meanInputChars', 'meanAnswerChars')}
            quality = sorted({key for value in values for key in value['quality']})
            methods[method]['quality'] = {key: statistics.mean(value['quality'][key]['mean'] for value in values if key in value['quality']) for key in quality}
        entry['holdout'].append({'requestedK': k, 'candidatePairs': trials[0]['n'], 'candidateInputs': trials[0]['u'], 'seedCount': len(trials), 'methods': methods})
    result['sources'].append(entry)
print(json.dumps(result, ensure_ascii=False, indent=2))
