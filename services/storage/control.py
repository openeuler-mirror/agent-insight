import hashlib
import json
import os
import sqlite3
import tempfile
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from .contracts import canonical_json, content_hash, identifier, revision


class StorageError(Exception):
    pass


class Conflict(StorageError):
    pass


SCHEMA_PATH = Path(__file__).parent / 'schema' / 'sqlite' / '001_core.sql'


class SQLiteControlStore:
    def __init__(self, path, *, clock=None):
        self.path = Path(path).absolute()
        self.clock = clock or (lambda: time.time_ns() // 1_000_000)

    def _validate_schema(self, con):
        try:
            rows = con.execute('SELECT version, name, checksum FROM schema_meta').fetchall()
        except sqlite3.DatabaseError as exc:
            raise StorageError('target is not an initialized core storage database') from exc
        expected = hashlib.sha256(SCHEMA_PATH.read_bytes()).hexdigest()
        if [tuple(row) for row in rows] != [(1, 'core', expected)]:
            raise StorageError('unsupported schema version or migration checksum mismatch')

    def initialize(self):
        sql = SCHEMA_PATH.read_text()
        digest = hashlib.sha256(sql.encode()).hexdigest()
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            with closing(sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True)) as con:
                self._validate_schema(con)
            return
        os.close(fd)
        with closing(sqlite3.connect(self.path)) as con:
            con.execute('PRAGMA foreign_keys=ON')
            con.execute('PRAGMA journal_mode=WAL')
            con.execute('PRAGMA synchronous=FULL')
            try:
                con.executescript('BEGIN IMMEDIATE;\n' + sql)
                con.execute('INSERT INTO schema_meta VALUES (?,?,?,?)', (1, 'core', digest, self.clock()))
                con.commit()
            except Exception:
                con.rollback()
                raise

    @contextmanager
    def transaction(self):
        if not self.path.is_file():
            raise StorageError('initialize an explicit new target before writing')
        con = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=10, isolation_level=None)
        con.row_factory = sqlite3.Row
        try:
            con.execute('PRAGMA foreign_keys=ON')
            self._validate_schema(con)
            con.execute('BEGIN IMMEDIATE')
            yield con
            con.commit()
        except sqlite3.IntegrityError as exc:
            con.rollback()
            raise Conflict('storage constraint violation') from exc
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def _manifest(self, value):
        if not self.path.is_file():
            raise StorageError('initialize an explicit new target before writing artifacts')
        with closing(sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True)) as con:
            self._validate_schema(con)
        body = canonical_json(value).encode('utf-8')
        digest = hashlib.sha256(body).hexdigest()
        directory = self.path.parent / (self.path.name + '.artifacts')
        directory.mkdir(mode=0o700, exist_ok=True)
        parent_fd = os.open(directory.parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        if directory.is_symlink() or directory.stat().st_mode & 0o077:
            raise StorageError('artifact directory must be private and not a symlink')
        target = directory / digest
        fd, temporary = tempfile.mkstemp(dir=directory)
        try:
            with os.fdopen(fd, 'wb') as out:
                out.write(body); out.flush(); os.fsync(out.fileno())
            try:
                os.link(temporary, target)
            except FileExistsError:
                if target.read_bytes() != body:
                    raise StorageError('artifact hash collision or corrupt content')
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        finally:
            os.unlink(temporary)
        return digest, str(target)

    def persist_artifact(self, manifest):
        return self._manifest(manifest)

    def _verify_artifact(self, digest, artifact_ref):
        target = Path(artifact_ref)
        directory = self.path.parent / (self.path.name + '.artifacts')
        if target.is_symlink() or target.parent != directory or target.name != digest or not target.is_file():
            raise Conflict('result must reference a durable artifact in this store')
        hasher = hashlib.sha256()
        with target.open('rb') as source:
            for block in iter(lambda: source.read(65536), b''):
                hasher.update(block)
        if hasher.hexdigest() != digest:
            raise Conflict('result artifact content hash mismatch')

    def create_workspace(self, workspace_id, name):
        identifier(workspace_id); identifier(name)
        now = self.clock()
        with self.transaction() as con:
            con.execute('INSERT INTO workspaces(workspace_id,name,created_at_ms,updated_at_ms) VALUES(?,?,?,?)', (workspace_id, name, now, now))

    def create_identity(self, workspace_id, asset_id, kind, name):
        for value in (workspace_id, asset_id, kind, name): identifier(value)
        now = self.clock()
        with self.transaction() as con:
            con.execute('INSERT INTO asset_identities(workspace_id,asset_id,kind,name,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?)', (workspace_id,asset_id,kind,name,now,now))

    def publish_release(self, workspace_id, asset_id, release_id, version_label, manifest, *, dependencies=(), publisher_id='local'):
        for value in (workspace_id, asset_id, release_id, version_label, publisher_id): identifier(value)
        deps = sorted((identifier(role), identifier(dep)) for role, dep in dependencies)
        if len(set(deps)) != len(deps): raise ValueError('duplicate dependency')
        packed = {'schema_version': 1, 'asset_id': asset_id, 'content': manifest, 'dependencies': [list(dep) for dep in deps]}
        digest, ref = self._manifest(packed)
        now = self.clock()
        with self.transaction() as con:
            old = con.execute('SELECT * FROM asset_releases WHERE workspace_id=? AND release_id=?', (workspace_id,release_id)).fetchone()
            if old:
                if (old['asset_id'],old['version_label'],old['content_hash']) != (asset_id,version_label,digest):
                    raise Conflict('release identity already has different immutable content')
                return dict(old)
            for _, dep in deps:
                if con.execute('SELECT 1 FROM asset_release_seals WHERE workspace_id=? AND release_id=?', (workspace_id,dep)).fetchone() is None:
                    raise Conflict('dependency must be a sealed release in the same workspace')
            con.execute('INSERT INTO asset_releases(workspace_id,release_id,asset_id,version_label,content_hash,manifest_ref,schema_version,publisher_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?)', (workspace_id,release_id,asset_id,version_label,digest,ref,1,publisher_id,now))
            con.executemany('INSERT INTO asset_release_dependencies(workspace_id,release_id,role,dependency_release_id,created_at_ms) VALUES(?,?,?,?,?)', [(workspace_id,release_id,role,dep,now) for role,dep in deps])
            con.execute('INSERT INTO asset_release_seals(workspace_id,release_id,asset_id,dependency_count,created_at_ms) VALUES(?,?,?,?,?)', (workspace_id,release_id,asset_id,len(deps),now))
            return dict(con.execute('SELECT * FROM asset_releases WHERE workspace_id=? AND release_id=?',(workspace_id,release_id)).fetchone())

    def move_alias(self, workspace_id, asset_id, alias, release_id, *, expected_etag):
        identifier(alias)
        if type(expected_etag) is not int or expected_etag < 0: raise ValueError('invalid expected etag')
        now = self.clock()
        with self.transaction() as con:
            if expected_etag == 0:
                con.execute('INSERT INTO asset_aliases(workspace_id,asset_id,alias,release_id,etag,created_at_ms,updated_at_ms) VALUES(?,?,?,?,1,?,?)',(workspace_id,asset_id,alias,release_id,now,now))
                return 1
            next_etag = revision(expected_etag + 1)
            result = con.execute('UPDATE asset_aliases SET release_id=?,etag=?,updated_at_ms=? WHERE workspace_id=? AND asset_id=? AND alias=? AND etag=?',(release_id,next_etag,now,workspace_id,asset_id,alias,expected_etag))
            if result.rowcount != 1: raise Conflict('alias changed concurrently')
            return next_etag

    def create_draft(self, workspace_id, draft_id, asset_id, manifest, *, base_release_id=None, branch='main'):
        body = canonical_json(manifest)
        now = self.clock()
        with self.transaction() as con:
            con.execute('INSERT INTO asset_drafts(workspace_id,draft_id,asset_id,branch_name,base_release_id,manifest_json,edit_revision,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,1,?,?)',(workspace_id,draft_id,asset_id,branch,base_release_id,body,now,now))

    def edit_draft(self, workspace_id, draft_id, manifest, *, expected_revision):
        revision(expected_revision)
        next_revision = revision(expected_revision + 1)
        with self.transaction() as con:
            result = con.execute('UPDATE asset_drafts SET manifest_json=?,edit_revision=?,updated_at_ms=? WHERE workspace_id=? AND draft_id=? AND edit_revision=?',(canonical_json(manifest),next_revision,self.clock(),workspace_id,draft_id,expected_revision))
            if result.rowcount != 1: raise Conflict('draft changed concurrently')
        return next_revision

    def create_run(self, workspace_id, run_id, releases, config, *, expected_case_count):
        if type(expected_case_count) is not int or expected_case_count < 0: raise ValueError('invalid expected case count')
        plan = {'releases': releases, 'config': config, 'expected_case_count': expected_case_count}
        digest, ref = self._manifest(plan)
        now = self.clock()
        with self.transaction() as con:
            for slot, release_id in releases.items():
                role = slot.split(':', 1)[0]
                asset = con.execute('SELECT a.kind FROM asset_release_seals s JOIN asset_identities a ON a.workspace_id=s.workspace_id AND a.asset_id=s.asset_id WHERE s.workspace_id=? AND s.release_id=?',(workspace_id,release_id)).fetchone()
                if asset is None or role not in {'agent','skill','evaluator','dataset','benchmark'} or asset['kind'] != role:
                    raise Conflict('run input requires a matching published asset kind in this workspace')
            con.execute("INSERT INTO runs(workspace_id,run_id,name,plan_hash,plan_manifest_ref,expected_case_count,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'draft',?,?)",(workspace_id,run_id,run_id,digest,ref,expected_case_count,now,now))
            con.executemany('INSERT INTO run_inputs(workspace_id,run_id,slot,release_id,config_hash,created_at_ms) VALUES(?,?,?,?,?,?)',[(workspace_id,run_id,slot,release_id,content_hash(config),now) for slot,release_id in releases.items()])
            con.execute("UPDATE runs SET status='queued',updated_at_ms=? WHERE workspace_id=? AND run_id=?",(now,workspace_id,run_id))

    def enqueue(self, workspace_id, work_item_id, run_id, case_key, *, phase='execute', evaluator_slot='default'):
        now = self.clock()
        with self.transaction() as con:
            con.execute("INSERT INTO work_items(workspace_id,work_item_id,run_id,case_key,phase,evaluator_slot,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'queued',?,?)",(workspace_id,work_item_id,run_id,case_key,phase,identifier(evaluator_slot),now,now))

    def claim(self, workspace_id, worker_id, *, lease_ms=30_000):
        identifier(worker_id)
        if type(lease_ms) is not int or not 0 < lease_ms <= 3_600_000: raise ValueError('invalid lease duration')
        now = self.clock()
        with self.transaction() as con:
            row = con.execute("""SELECT w.* FROM work_items w WHERE w.workspace_id=? AND w.cancel_requested=0
                AND w.next_attempt_at_ms<=? AND (w.status='queued' OR (w.status='running' AND EXISTS
                (SELECT 1 FROM work_attempts a WHERE a.workspace_id=w.workspace_id AND a.work_item_id=w.work_item_id AND a.status='running' AND a.lease_until_ms<=?)))
                ORDER BY w.priority DESC,w.created_at_ms,w.work_item_id LIMIT 1""",(workspace_id,now,now)).fetchone()
            if row is None: return None
            item = row['work_item_id']
            con.execute("UPDATE work_attempts SET status='expired',finished_at_ms=? WHERE workspace_id=? AND work_item_id=? AND status='running' AND lease_until_ms<=?",(now,workspace_id,item,now))
            attempt_no = con.execute('SELECT COALESCE(MAX(attempt_no),0)+1 FROM work_attempts WHERE workspace_id=? AND work_item_id=?',(workspace_id,item)).fetchone()[0]
            fence = revision(row['etag'] + 1)
            attempt_id = str(uuid.uuid4())
            con.execute("UPDATE work_items SET status='running',etag=?,updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(fence,now,workspace_id,item))
            con.execute("INSERT INTO work_attempts(workspace_id,attempt_id,work_item_id,attempt_no,fence,worker_id,status,lease_until_ms,started_at_ms) VALUES(?,?,?,?,?,?,'running',?,?)",(workspace_id,attempt_id,item,attempt_no,fence,worker_id,now+lease_ms,now))
            return dict(con.execute('SELECT * FROM work_attempts WHERE workspace_id=? AND attempt_id=?',(workspace_id,attempt_id)).fetchone())

    def renew(self, workspace_id, attempt_id, fence, *, lease_ms=30_000):
        revision(fence)
        if type(lease_ms) is not int or not 0 < lease_ms <= 3_600_000:
            raise ValueError('invalid lease duration')
        now = self.clock()
        with self.transaction() as con:
            result = con.execute("""UPDATE work_attempts SET lease_until_ms=?
                WHERE workspace_id=? AND attempt_id=? AND fence=? AND status='running' AND lease_until_ms>?
                AND EXISTS(SELECT 1 FROM work_items w WHERE w.workspace_id=work_attempts.workspace_id
                  AND w.work_item_id=work_attempts.work_item_id AND w.etag=? AND w.status='running' AND w.cancel_requested=0)""",
                (now+lease_ms,workspace_id,attempt_id,fence,now,fence))
            if result.rowcount != 1:
                raise Conflict('cannot renew expired, cancelled or superseded attempt')
        return now+lease_ms

    def complete(self, workspace_id, attempt_id, fence, receipt_key, result_id, digest, artifact_ref, *, evaluator_slot='default'):
        revision(fence)
        for value in (workspace_id,attempt_id,receipt_key,result_id,artifact_ref): identifier(value)
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest): raise ValueError('invalid content hash')
        self._verify_artifact(digest, artifact_ref)
        now = self.clock()
        with self.transaction() as con:
            old = con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND attempt_id=? AND receipt_key=?',(workspace_id,attempt_id,receipt_key)).fetchone()
            attempt = con.execute('SELECT a.*,w.run_id,w.case_key,w.evaluator_slot,w.etag,w.cancel_requested,w.status AS item_status FROM work_attempts a JOIN work_items w ON a.workspace_id=w.workspace_id AND a.work_item_id=w.work_item_id WHERE a.workspace_id=? AND a.attempt_id=?',(workspace_id,attempt_id)).fetchone()
            if attempt is not None and evaluator_slot != attempt['evaluator_slot']:
                raise Conflict('callback evaluator slot differs from frozen work item')
            if attempt is None or attempt['fence'] != fence: raise Conflict('attempt fence is stale')
            if old:
                if (old['result_id'],old['content_hash'],old['artifact_ref'],old['evaluator_slot']) != (result_id,digest,artifact_ref,evaluator_slot): raise Conflict('conflicting duplicate result receipt')
                return dict(old)
            if attempt['status']!='running' or attempt['item_status']!='running' or attempt['cancel_requested'] or attempt['etag']!=fence or attempt['lease_until_ms']<=now:
                raise Conflict('attempt is cancelled, expired, completed or superseded')
            receipt_id = str(uuid.uuid4())
            con.execute('INSERT INTO result_receipts(workspace_id,receipt_id,run_id,work_item_id,case_key,evaluator_slot,attempt_id,receipt_key,result_id,content_hash,artifact_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(workspace_id,receipt_id,attempt['run_id'],attempt['work_item_id'],attempt['case_key'],identifier(evaluator_slot),attempt_id,receipt_key,result_id,digest,artifact_ref,now))
            con.execute("UPDATE work_attempts SET status='done',finished_at_ms=? WHERE workspace_id=? AND attempt_id=?",(now,workspace_id,attempt_id))
            con.execute("UPDATE work_items SET status='done',updated_at_ms=? WHERE workspace_id=? AND work_item_id=?",(now,workspace_id,attempt['work_item_id']))
            payload=canonical_json({'result_id':result_id,'content_hash':digest,'artifact_ref':artifact_ref,'run_id':attempt['run_id'],'attempt_id':attempt_id,'case_key':attempt['case_key'],'evaluator_slot':evaluator_slot})
            con.execute("INSERT INTO outbox_events(workspace_id,event_id,aggregate_id,aggregate_revision,event_type,payload_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",(workspace_id,str(uuid.uuid4()),attempt_id,fence,'evaluation.result.accepted.v1',payload,now,now))
            return dict(con.execute('SELECT * FROM result_receipts WHERE workspace_id=? AND receipt_id=?',(workspace_id,receipt_id)).fetchone())

    def cancel(self, workspace_id, work_item_id):
        now = self.clock()
        with self.transaction() as con:
            result=con.execute("UPDATE work_items SET status='cancelled',cancel_requested=1,etag=etag+1,updated_at_ms=? WHERE workspace_id=? AND work_item_id=? AND status IN ('queued','running')",(now,workspace_id,work_item_id))
            if result.rowcount:
                con.execute("UPDATE work_attempts SET status='cancelled',finished_at_ms=? WHERE workspace_id=? AND work_item_id=? AND status='running'",(now,workspace_id,work_item_id))
            return result.rowcount == 1
