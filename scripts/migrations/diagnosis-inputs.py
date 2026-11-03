#!/usr/bin/env python3
"""Add diagnosis inputs without rewriting historical values. Requires quiesced writers."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path

DDL = '''CREATE TABLE "DiagnosisRun" (
"id" TEXT NOT NULL PRIMARY KEY, "user" TEXT NOT NULL, "experimentId" TEXT,
"caseId" TEXT, "executionId" TEXT NOT NULL, "attemptId" TEXT,
"requestKey" TEXT NOT NULL, "inputHash" TEXT NOT NULL, "inputSnapshotJson" TEXT NOT NULL,
"generatorVersion" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
"reportJson" TEXT, "errorMessage" TEXT, "retryOfRunId" TEXT, "leaseUntil" DATETIME,
"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" DATETIME)'''
INDEXES = [
'CREATE UNIQUE INDEX "DiagnosisRun_user_requestKey_key" ON "DiagnosisRun"("user", "requestKey")',
'CREATE INDEX "DiagnosisRun_user_inputHash_generatorVersion_status_idx" ON "DiagnosisRun"("user", "inputHash", "generatorVersion", "status")',
'CREATE INDEX "DiagnosisRun_user_experimentId_caseId_createdAt_idx" ON "DiagnosisRun"("user", "experimentId", "caseId", "createdAt")']

def quote(name):
    return '"' + name.replace('"', '""') + '"'

def structure(db):
    return {r[0]: [c[1] for c in db.execute('PRAGMA table_info(' + quote(r[0]) + ')')]
            for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}

def fingerprints(db, columns):
    result = {}
    for name, cols in columns.items():
        hashes = []
        for row in db.execute('SELECT ' + ','.join(map(quote, cols)) + ' FROM ' + quote(name)):
            values = [(type(v).__name__, v.hex() if isinstance(v, bytes) else v) for v in row]
            hashes.append(hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest())
        result[name] = {'rows': len(hashes), 'sha256': hashlib.sha256(''.join(sorted(hashes)).encode()).hexdigest()}
    return result

def integrity(db):
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise RuntimeError('Database integrity check failed')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise RuntimeError('Foreign key violations: resolve explicitly before migration')

def migrate(database, backup, apply=False):
    database = Path(database).resolve(strict=True)
    db = sqlite3.connect(database.as_uri() + '?mode=rw', uri=True, timeout=5)
    try:
        db.execute('PRAGMA foreign_keys=ON')
        integrity(db)
        columns = structure(db)
        if 'SkillOptPlanItem' not in columns:
            raise RuntimeError('Unsupported schema: SkillOptPlanItem is missing')
        if not apply:
            return {'mode': 'preflight', 'database': str(database), 'tables': fingerprints(db, columns)}
        backup = Path(backup).resolve()
        if backup.exists() or backup == database:
            raise RuntimeError('Backup destination must be a new file')
        # Use the backup API before acquiring the write transaction; compare it under lock.
        backup.touch(mode=0o600, exist_ok=False)
        with sqlite3.connect(backup) as target:
            db.backup(target)
            integrity(target)
            before = fingerprints(target, columns)
        db.execute('BEGIN IMMEDIATE')
        try:
            if structure(db) != columns or fingerprints(db, columns) != before:
                raise RuntimeError('Concurrent writes detected; quiesce writers and retry with a fresh backup')
            objects = db.execute("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL").fetchall()
            if 'DiagnosisRun' not in columns:
                db.execute(DDL)
                for sql in INDEXES:
                    db.execute(sql)
            else:
                expected = {'id','user','experimentId','caseId','executionId','attemptId','requestKey','inputHash','inputSnapshotJson','generatorVersion','status','reportJson','errorMessage','retryOfRunId','leaseUntil','createdAt','completedAt'}
                if set(columns['DiagnosisRun']) != expected:
                    raise RuntimeError('Unexpected existing DiagnosisRun schema')
                for sql in INDEXES:
                    name = sql.split('"')[1]
                    existing = db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=?", (name,)).fetchone()
                    if not existing or ''.join(existing[0].split()) != ''.join(sql.split()):
                        raise RuntimeError('Unexpected DiagnosisRun index: ' + name)
            expected_db = sqlite3.connect(':memory:')
            try:
                expected_db.execute(DDL)
                if db.execute('PRAGMA table_info(DiagnosisRun)').fetchall() != expected_db.execute('PRAGMA table_info(DiagnosisRun)').fetchall():
                    raise RuntimeError('Existing DiagnosisRun column definitions are incompatible')
            finally:
                expected_db.close()
            if 'sourceRefsJson' not in columns['SkillOptPlanItem']:
                db.execute('ALTER TABLE "SkillOptPlanItem" ADD COLUMN "sourceRefsJson" TEXT NOT NULL DEFAULT \'[]\'')
            field = next(r for r in db.execute('PRAGMA table_info(SkillOptPlanItem)') if r[1] == 'sourceRefsJson')
            if field[2:5] != ('TEXT', 1, "'[]'"):
                raise RuntimeError('Unexpected sourceRefsJson definition')
            if fingerprints(db, columns) != before:
                raise RuntimeError('Historical data changed; rolling back')
            for obj in objects:
                if db.execute('SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=?', obj[:2]).fetchone() != obj:
                    raise RuntimeError('Historical index/trigger changed')
            integrity(db)
            db.commit()
        except BaseException:
            db.rollback()
            raise
        return {'mode': 'applied', 'database': str(database), 'backup': str(backup), 'historicalDataUnchanged': True, 'tables': before}
    finally:
        db.close()

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--database', required=True)
    p.add_argument('--backup')
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    if args.apply and not args.backup:
        p.error('--apply requires --backup')
    print(json.dumps(migrate(args.database, args.backup, args.apply), indent=2))
