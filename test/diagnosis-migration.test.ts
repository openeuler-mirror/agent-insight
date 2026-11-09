import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('diagnosis migration preserves historical data, repeats safely and rolls back incompatible schemas', () => {
  const result = spawnSync('python3', ['-c', String.raw`
import importlib.util, pathlib, sqlite3, tempfile
spec = importlib.util.spec_from_file_location('migration', 'scripts/migrations/diagnosis-inputs.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
root = pathlib.Path(tempfile.mkdtemp(prefix='diagnosis-migration-'))
original = root / 'original.db'
with sqlite3.connect(original) as db:
    db.executescript('''
CREATE TABLE SkillOptPlanItem (id TEXT PRIMARY KEY, evidence TEXT, score REAL, payload BLOB);
CREATE INDEX historic_evidence ON SkillOptPlanItem(evidence);
CREATE TABLE Audit (id TEXT);
CREATE TRIGGER historic_audit AFTER INSERT ON SkillOptPlanItem BEGIN INSERT INTO Audit VALUES(new.id); END;
''')
    db.executemany('INSERT INTO SkillOptPlanItem VALUES (?,?,?,?)', [('one', '中文\\n"证据"', 95.7, bytes([0, 255])), ('two', None, None, b'')])
preflight = migration.migrate(original, None)
assert preflight['mode'] == 'preflight'
backup = root / 'backup.db'
first = migration.migrate(original, backup, True)
assert first['historicalDataUnchanged']
assert first['tables'] == preflight['tables']
with sqlite3.connect(original) as db:
    assert db.execute('SELECT sourceRefsJson FROM SkillOptPlanItem').fetchall() == [('[]',), ('[]',)]
    db.execute("INSERT INTO DiagnosisRun(id,user,executionId,requestKey,inputHash,inputSnapshotJson,generatorVersion) VALUES('run','u','trace','key','hash','{}','v1')")
second = migration.migrate(original, root / 'backup2.db', True)
assert second['historicalDataUnchanged']
with sqlite3.connect(original) as db:
    assert db.execute('SELECT count(*) FROM DiagnosisRun').fetchone() == (1,)
with sqlite3.connect(backup) as source, sqlite3.connect(root / 'restored.db') as restored:
    source.backup(restored)
    assert migration.fingerprints(restored, migration.structure(restored)) == preflight['tables']
    assert 'DiagnosisRun' not in migration.structure(restored)
assert (backup.stat().st_mode & 0o777) == 0o600
try:
    migration.migrate(original, backup, True)
    raise AssertionError('existing backup overwritten')
except RuntimeError as error:
    assert 'new file' in str(error)
bad = root / 'bad.db'
with sqlite3.connect(bad) as db:
    db.execute('CREATE TABLE SkillOptPlanItem(id TEXT PRIMARY KEY, sourceRefsJson INTEGER)')
    db.execute("INSERT INTO SkillOptPlanItem VALUES('legacy',42)")
try:
    migration.migrate(bad, root / 'bad-backup.db', True)
    raise AssertionError('incompatible schema accepted')
except RuntimeError as error:
    assert 'sourceRefsJson' in str(error)
with sqlite3.connect(bad) as db:
    assert 'DiagnosisRun' not in migration.structure(db)
    assert db.execute('SELECT * FROM SkillOptPlanItem').fetchall() == [('legacy',42)]
    migration.integrity(db)
invalid = root / 'invalid.db'
with sqlite3.connect(invalid) as db:
    db.executescript('CREATE TABLE SkillOptPlanItem(id TEXT PRIMARY KEY); CREATE TABLE Child(parent TEXT REFERENCES SkillOptPlanItem(id)); INSERT INTO Child VALUES("missing");')
try:
    migration.migrate(invalid, root / 'invalid-backup.db', True)
    raise AssertionError('foreign key corruption accepted')
except RuntimeError as error:
    assert 'Foreign key violations' in str(error)
assert not (root / 'invalid-backup.db').exists()
print('migration, repeat, backup recovery, rollback, corruption rejection: PASS')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
