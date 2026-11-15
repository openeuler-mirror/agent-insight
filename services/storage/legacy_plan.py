"""Bounded read-only diagnostics; no destination connection or migration apply."""
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sqlite3
import time

from .iam import _login_name
from .legacy import LegacyValidationError, _encode_value, _quote, _schema_objects


class _BudgetStop(Exception):
    pass


def _hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _finish(report, issue_counts):
    accounting=report['row_accounting']
    accounting['observed_source_rows']=sum(table['row_count'] for table in report['tables'])
    accounting['unscanned_observed_rows']=accounting['observed_source_rows']-accounting['scanned_rows']
    if not report['scan_complete']:report['source_content_sha256']=None
    report['blocking_reasons']=['semantic_transformers_not_implemented']
    if report['issue_count']:report['blocking_reasons'].append('source_diagnostics_require_resolution')
    if not report['scan_complete']:report['blocking_reasons'].append('diagnostics_incomplete')
    report['issue_counts']=dict(sorted(issue_counts.items()))
    report['issues_truncated']=report['issue_count']>sum(item['count'] for item in report['issues'])
    report['plan_sha256']=_hash(report)
    return report


def load_catalog():
    catalog = json.loads((Path(__file__).parent / 'schema' / 'legacy-catalog.json').read_text())
    schema = Path(__file__).resolve().parents[2] / 'prisma' / 'schema.prisma'
    if schema.is_file() and hashlib.sha256(schema.read_bytes()).hexdigest() != catalog['schema_sha256']:
        raise LegacyValidationError('Legacy catalog is stale for the current Prisma schema; regenerate and review it')
    return catalog


def _valid_value(column, value):
    if value is None: return not column['required']
    kind = column['prisma_type']
    if kind == 'String': return isinstance(value, str)
    if kind in {'Int', 'BigInt'}: return type(value) is int
    if kind == 'Float': return type(value) in (int, float)
    if kind == 'Boolean': return type(value) is int and value in (0, 1)
    if kind == 'DateTime': return type(value) in (int, str)
    if kind == 'Bytes': return isinstance(value, bytes)
    return False


def _bindings(value):
    value = {} if value is None else value
    if not isinstance(value, dict):
        raise LegacyValidationError('Bindings must be an explicit owner mapping object')
    for owner, target in value.items():
        if (not isinstance(owner, str) or not owner or not isinstance(target, dict)
                or set(target) != {'principal_id', 'workspace_id'}
                or any(not isinstance(v, str) or not v or len(v) > 256
                       or any(ord(c) < 32 or ord(c) == 127 for c in v) for v in target.values())):
            raise LegacyValidationError('Bindings require exact source owner and principal/workspace IDs; credentials are not accepted')
    return value


def plan_database(path, *, source_id, bindings=None, max_rows=100000,
                  max_bytes=64 * 1024 * 1024, max_row_bytes=8 * 1024 * 1024,
                  max_issues=256, max_tables=512, max_columns=256,
                  max_seconds=15, max_vm_steps=10000000):
    if not isinstance(source_id, str) or not source_id or len(source_id) > 512:
        raise LegacyValidationError('An explicit stable source ID is required')
    limits = {'max_rows': max_rows, 'max_bytes': max_bytes, 'max_row_bytes': max_row_bytes,
              'max_issues': max_issues, 'max_tables': max_tables, 'max_columns': max_columns,
              'max_vm_steps': max_vm_steps}
    if any(type(v) is not int or not 1 <= v <= 2 ** 31 - 1 for v in limits.values()):
        raise LegacyValidationError('Positive bounded integer scan limits are required')
    if type(max_seconds) not in (int, float) or not 0 < max_seconds <= 120:
        raise LegacyValidationError('Scan time budget must be within 120 seconds')
    limits['max_seconds'] = max_seconds
    bindings = _bindings(bindings)
    catalog = load_catalog()
    models = {m['model']: m for m in catalog['models']}
    physical = {m['table']: m for m in catalog['models']}
    report = {
        'format_version': 1, 'mode': 'planning-only', 'status': 'blocked',
        'full_migration_ready': False, 'scan_complete': True,
        'source_id_sha256': _hash(source_id), 'catalog_version': catalog['version'],
        'catalog_sha256': _hash(catalog), 'mapping_sha256': _hash(bindings),
        'source_schema_sha256': None, 'source_content_sha256': None,
        'fingerprint_format': 'legacy-plan-typed-row-multiset/v1',
        'limits': limits, 'issues': [], 'issue_count': 0, 'issue_counts': {},
        'tables': [], 'dependencies': [],
        'row_accounting': {'scanned_rows': 0, 'limited_trace_candidate': 0,
                           'pending_conversion': 0, 'raw_retained': 0},
        'coverage': {'semantic_import': 'not_implemented',
                     'trace_import': 'Session/Execution allowlist only; candidates are not import approval',
                     'raw_retention': 'source retained; plan does not export or copy rows',
                     'json': 'private pending transformation; no historical reconstruction',
                     'additional_logical_relations': 'only catalog declarations and listed logical/native identities checked'},
    }
    issue_counts = Counter()

    def issue(code, table=None, field=None, locator=None, count=1):
        report['issue_count'] += count
        issue_counts[code] += count
        if len(report['issues']) < max_issues:
            item = {'code': code, 'count': count}
            if table is not None: item['table'] = table
            if field is not None: item['field'] = field
            if locator is not None: item['locator_sha256'] = locator
            report['issues'].append(item)

    def incomplete(code):
        report['scan_complete'] = False
        issue(code)

    source = Path(path).resolve(strict=True)
    if not source.is_file():
        raise LegacyValidationError('Source must be an explicit existing SQLite file')
    started = time.monotonic()
    steps = 0

    def progress():
        nonlocal steps
        steps += 1000
        return int(steps > max_vm_steps or time.monotonic() - started > max_seconds)

    def expired():
        return steps > max_vm_steps or time.monotonic() - started > max_seconds

    data = {}
    table_digests = []
    total_bytes = 0
    db = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=1)
    db.set_progress_handler(progress, 1000)
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        object_count, schema_bytes, largest_ddl = db.execute(
            "SELECT count(*),coalesce(sum(length(CAST(sql AS BLOB))+length(name)+length(tbl_name)),0),"
            "coalesce(max(length(CAST(sql AS BLOB))),0) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'"
        ).fetchone()
        if object_count > max_tables * 16:
            incomplete('schema_object_budget_exceeded'); raise _BudgetStop()
        if schema_bytes > max_bytes or largest_ddl > max_row_bytes:
            incomplete('schema_byte_budget_exceeded'); raise _BudgetStop()
        objects = _schema_objects(db)
        report['source_schema_sha256'] = _hash(objects)
        actual_tables = sorted(obj['name'] for obj in objects if obj['type'] == 'table')
        if len(actual_tables) > max_tables:
            incomplete('table_budget_exceeded')
            actual_tables = actual_tables[:max_tables]
        present = set(actual_tables)
        for model in catalog['models']:
            if model['table'] not in present: issue('missing_table', model['table'])
            for relation in model['relations'] + model['logical_relations']:
                report['dependencies'].append({'from_model': model['model'], 'field': relation['field'],
                    'to_model': relation['target_model'], 'kind': 'declared' if relation in model['relations'] else 'logical'})
        for result in db.execute('PRAGMA integrity_check'):
            if result != ('ok',): issue('integrity_check_failed')
            if expired():
                incomplete('scan_time_or_vm_budget_exceeded'); break
        for index, violation in enumerate(db.execute('PRAGMA foreign_key_check')):
            if index >= max_rows:
                incomplete('foreign_key_budget_exceeded'); break
            issue('foreign_key_orphan', locator=_hash([source_id, 'foreign_key', list(violation)]))
        for name in actual_tables:
            if expired():
                incomplete('scan_time_or_vm_budget_exceeded'); break
            model = physical.get(name)
            columns = db.execute('PRAGMA table_xinfo(' + _quote(name) + ')').fetchmany(max_columns + 1)
            if len(columns) > max_columns:
                incomplete('column_budget_exceeded'); break
            columns = [c for c in columns if c[6] != 1]
            names = [c[1] for c in columns]
            descriptor = {'table': name, 'model': model['model'] if model else None,
                          'domain': model['domain'] if model else 'unclassified',
                          'target': model['target'] if model else 'private_raw_retention_only',
                          'migration_status': model['migration_status'] if model else 'unclassified',
                          'row_count': db.execute('SELECT count(*) FROM ' + _quote(name)).fetchone()[0],
                          'scanned_rows': 0, 'field_coverage': []}
            report['tables'].append(descriptor)
            if model is None:
                issue('unknown_table', name)
                descriptor['field_coverage'] = [{'column': n, 'handling': 'private_raw_retention_only'} for n in names]
            else:
                expected = {c['column']: c for c in model['columns']}
                for column in columns:
                    known = expected.get(column[1])
                    if known is None:
                        issue('unknown_column', name, column[1])
                        descriptor['field_coverage'].append({'column': column[1], 'handling': 'private_raw_retention_only'})
                    else:
                        descriptor['field_coverage'].append({k: known[k] for k in ('field', 'column', 'handling', 'sensitivity', 'structured_content')})
                        if column[2].upper() != known['sqlite_type']:
                            issue('column_type_drift', name, known['field'])
                        if bool(column[3]) != known['required']:
                            issue('column_nullability_drift', name, known['field'])
                for missing in sorted(set(expected) - set(names)):
                    issue('missing_column', name, expected[missing]['field'])
                key = [c[1] for c in sorted(columns, key=lambda c: c[5]) if c[5]]
                if key != model['primary_key']: issue('primary_key_drift', name)
                unique = []
                for idx in db.execute('PRAGMA index_list(' + _quote(name) + ')'):
                    if idx[2] and idx[3] != 'pk':
                        fields = [c[2] for c in db.execute('PRAGMA index_info(' + _quote(idx[1]) + ')')]
                        unique.append(fields)
                if sorted(unique, key=str) != sorted(model['unique_keys'], key=str): issue('unique_key_drift', name)
                actual_fk = defaultdict(list)
                for fk in db.execute('PRAGMA foreign_key_list(' + _quote(name) + ')'):
                    actual_fk[(fk[0], fk[2])].append((fk[1], fk[3], fk[4]))
                observed = sorted((target, tuple(x[1] for x in sorted(items)), tuple(x[2] for x in sorted(items))) for (_, target), items in actual_fk.items())
                expected_fk = sorted((models[r['target_model']]['table'], tuple(r['from']), tuple(r['to'])) for r in model['relations'])
                if observed != expected_fk: issue('foreign_key_declaration_drift', name)
            if not names:
                incomplete('unreadable_table'); continue
            size_sql = '(' + '+'.join('coalesce(length(CAST(' + _quote(n) + ' AS BLOB)),0)' for n in names) + ')'
            selection = ','.join('CASE WHEN ' + size_sql + '<=? THEN ' + _quote(n) + ' ELSE NULL END' for n in names)
            remaining = max_rows - report['row_accounting']['scanned_rows']
            order = [c[1] for c in sorted(columns, key=lambda c: c[5]) if c[5]]
            query = 'SELECT ' + size_sql + ',' + selection + ' FROM ' + _quote(name)
            if order: query += ' ORDER BY ' + ','.join(_quote(n) for n in order)
            query += ' LIMIT ?'
            digests = []
            records = []
            for row in db.execute(query, [max_row_bytes] * len(names) + [remaining + 1]):
                if report['row_accounting']['scanned_rows'] >= max_rows:
                    incomplete('row_budget_exceeded'); break
                size = row[0]
                if size > max_row_bytes or total_bytes + size > max_bytes:
                    incomplete('byte_budget_exceeded'); break
                total_bytes += size
                values = list(row[1:])
                digests.append(_hash([_encode_value(v) for v in values]))
                records.append(dict(zip(names, values)))
                descriptor['scanned_rows'] += 1
                accounting = report['row_accounting']
                accounting['scanned_rows'] += 1
                bucket = 'raw_retained' if not model else 'limited_trace_candidate' if model['model'] in {'Execution', 'Session'} else 'pending_conversion'
                accounting[bucket] += 1
                if expired(): incomplete('scan_time_or_vm_budget_exceeded'); break
            descriptor['rows_sha256'] = _hash(sorted(digests))
            if descriptor['scanned_rows'] != descriptor['row_count']: report['scan_complete'] = False
            table_digests.append({'table': name, 'columns': names, 'row_count': descriptor['scanned_rows'], 'rows_sha256': descriptor['rows_sha256']})
            data[name] = records
            if not report['scan_complete']: break
        if report['scan_complete']:
            report['source_content_sha256'] = _hash({'schema': report['source_schema_sha256'], 'tables': table_digests})
    except _BudgetStop:
        pass
    except sqlite3.DatabaseError:
        incomplete('sqlite_diagnostic_incomplete')
    finally:
        db.set_progress_handler(None, 0)
        db.rollback()
        db.close()

    if not report['scan_complete']:
        report['coverage']['semantic_diagnostics']='not_run_incomplete_snapshot'
        return _finish(report,issue_counts)
    report['coverage']['semantic_diagnostics']='catalog_relations_and_declared_checks_only'

    # All joins use the bounded in-memory snapshot, never a second source transaction.
    indexes = {}

    def matches(target, fields, values):
        key = (target, tuple(fields))
        if key not in indexes:
            index = defaultdict(list)
            for row in data.get(models[target]['table'], []):
                index[tuple(row.get(f) for f in fields)].append(row)
            indexes[key] = index
        return indexes[key].get(tuple(values), [])

    def locate(model, row):
        return _hash([source_id, model['table'], [_encode_value(row.get(k)) for k in model['primary_key']]])

    owner_cache = {}

    def owners(model, row, seen=frozenset()):
        key = (model['model'], locate(model, row))
        if key in owner_cache: return owner_cache[key]
        if key in seen or len(seen) >= 32: return set()
        if model['owner']['kind'] == 'direct':
            value = row.get(model['owner']['column'])
            result = {value} if isinstance(value, str) and value else set()
        else:
            result = set()
            for relation in model['relations'] + model['logical_relations']:
                values = [row.get(f) for f in relation['from']]
                if any(v is None for v in values): continue
                for parent in matches(relation['target_model'], relation['to'], values):
                    result.update(owners(models[relation['target_model']], parent, seen | {key}))
        owner_cache[key] = result
        return result

    users = defaultdict(list)
    normalized = defaultdict(list)
    for row in data.get('User', []):
        username = row.get('username')
        if isinstance(username, str): users[username].append(row)
        try: normalized[_login_name(username)].append(row)
        except ValueError: issue('invalid_iam_login', 'User', 'username', locate(models['User'], row))
    for rows in normalized.values():
        if len(rows) > 1:
            issue('login_collision', 'User', 'username', count=len(rows))
    for rows in users.values():
        if len(rows) > 1: issue('ambiguous_source_user', 'User', 'username', count=len(rows))
    mapped = Counter((v['principal_id'], v['workspace_id']) for v in bindings.values())
    for count in mapped.values():
        if count > 1: issue('ambiguous_owner_mapping', count=count)
    native = Counter()
    for name, records in data.items():
        model = physical.get(name)
        if model is None: continue
        for row in records:
            if expired():
                incomplete('analysis_time_budget_exceeded'); break
            locator = locate(model, row)
            source_owners = owners(model, row)
            for column in model['columns']:
                if column['column'] not in row: continue
                if not _valid_value(column, row[column['column']]):
                    issue('row_value_type_mismatch', name, column['field'], locator)
            if len(source_owners) != 1: issue('owner_ambiguous' if source_owners else 'owner_missing', name, locator=locator)
            for owner in source_owners:
                if len(users.get(owner, [])) != 1: issue('owner_not_registered', name, locator=locator)
                if owner not in bindings: issue('owner_unmapped', name, locator=locator)
            for relation in model['relations'] + model['logical_relations']:
                values = [row.get(f) for f in relation['from']]
                if any(v is None for v in values): continue
                found = matches(relation['target_model'], relation['to'], values)
                code = 'declared_reference_orphan' if relation in model['relations'] else 'logical_reference_orphan'
                if not found: issue(code, name, relation['from'][0], locator)
                elif len(found) > 1: issue('ambiguous_reference', name, relation['from'][0], locator)
                elif source_owners and owners(models[relation['target_model']], found[0]) != source_owners:
                    issue('cross_owner_reference', name, relation['from'][0], locator)
            if model['native_identity'] and row.get('sourceExecutionId') is not None:
                native[tuple(row.get(f) for f in model['native_identity'])] += 1
    for count in native.values():
        if count > 1: issue('ambiguous_native_source_identity', 'Execution', 'sourceExecutionId', count=count)
    execution_rows = data.get('Execution', [])
    by_id = {row.get('id'): row for row in execution_rows if row.get('id') is not None}
    finished = set()
    for row in execution_rows:
        current = row.get('id'); trail = []; positions = {}
        while current in by_id and current not in finished:
            if expired():
                incomplete('analysis_time_budget_exceeded'); break
            if current in positions:
                cycle = trail[positions[current]:]
                issue('execution_parent_cycle', 'Execution', 'parentExecutionId',
                      locate(models['Execution'], by_id[current]), count=len(cycle))
                break
            positions[current] = len(trail); trail.append(current)
            current = by_id[current].get('parentExecutionId')
        finished.update(trail)
        if expired(): break
    if expired():incomplete('analysis_time_budget_exceeded')
    return _finish(report,issue_counts)
