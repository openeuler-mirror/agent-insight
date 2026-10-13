"""Independently audit frozen input hashes, selected IDs and human-score arithmetic."""
import argparse
import collections
import hashlib
import json
import math
import pathlib
import unicodedata


def normalize(text):
    return unicodedata.normalize('NFC', text.replace('\r\n', '\n').replace('\r', '\n'))


def pair_key(row):
    pair = [normalize(row['input']), normalize(row['reference_output'])]
    return hashlib.sha256(json.dumps(pair, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def audit(data, results):
    totals = {'datasets': 0, 'scenarios': 0, 'seedTrials': 0, 'methodRuns': 0, 'selectedItemsChecked': 0, 'qualityMeansChecked': 0}
    for name in ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']:
        report = json.loads((results / (name + '.json')).read_text())
        assert report.get('finishedAt'), (name, 'unfinished')
        content = (data / report['source']['file']).read_bytes()
        assert hashlib.sha256(content).hexdigest() == report['source']['sha256']
        raw = json.loads(content)
        strata = collections.defaultdict(list)
        for row in raw:
            stratum = row['domain'] + '/' + row['split'] if name == 'SummarizeFeedback' else 'all'
            strata[stratum].append(row)
        totals['datasets'] += 1
        for scenario in report['experiments']:
            pairs = {}
            for row in strata[scenario['stratum']]:
                if not row['input'].strip() or not row['reference_output'].strip():
                    continue
                k = pair_key(row)
                p = pairs.setdefault(k, {'refs': [], 'labels': collections.defaultdict(list)})
                p['refs'].append(row['rowId'])
                for axis, value in row.get('quality', {}).items():
                    if isinstance(value, (int, float)) and math.isfinite(value):
                        p['labels'][axis].append(value)
            if scenario['population'] == 'quality-annotated':
                pairs = {k: p for k, p in pairs.items() if p['labels'].get('quality')}
            pool = set(scenario['poolKeys'])
            assert len(pool) == scenario['actualPairs']
            assert pool <= pairs.keys()
            totals['scenarios'] += 1
            for trial in scenario['trials']:
                totals['seedTrials'] += 1
                assert trial['methods']['B3']['selected'] == trial['methods']['B4']['selected']
                for method in trial['methods'].values():
                    selected = method['selected']
                    assert len(selected) == min(100, len(pool))
                    assert len(set(s['key'] for s in selected)) == len(selected)
                    assert all(s['key'] in pool and s['rowIds'] == pairs[s['key']]['refs'] for s in selected)
                    totals['selectedItemsChecked'] += len(selected)
                    totals['methodRuns'] += 1
                    expected = collections.defaultdict(list)
                    for selected_row in selected:
                        for axis, values in pairs[selected_row['key']]['labels'].items():
                            expected[axis].append(sum(values) / len(values))
                    assert set(expected) == set(method['metrics']['quality'])
                    for axis, values in expected.items():
                        actual = method['metrics']['quality'][axis]
                        assert actual['labeled'] == len(values)
                        assert math.isclose(actual['mean'], sum(values) / len(values), abs_tol=1e-10)
                        totals['qualityMeansChecked'] += 1
    totals['passed'] = True
    print(json.dumps(totals, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('data', type=pathlib.Path)
    parser.add_argument('results', type=pathlib.Path)
    args = parser.parse_args()
    audit(args.data, args.results)
