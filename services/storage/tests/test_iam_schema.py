import hashlib
import json
import os
import re
import sqlite3
import subprocess
import unittest
import uuid
import time
from pathlib import Path

SCHEMA = Path(__file__).resolve().parents[1] / 'schema'


class IamSchemaFilesTest(unittest.TestCase):
    def test_additive_baseline_files_exist(self):
        for backend in ('sqlite','postgresql','opengauss'):
            self.assertTrue((SCHEMA/backend/'002_iam.sql').is_file(), backend)

    def test_core_baseline_bytes_preserved(self):
        expected={'sqlite':'a534293881ac948d3e81f24f9af3449201f88245ef7661154751d63024a4b65f',
                  'postgresql':'744782c5c2aff0cbd27aecafc4b6315bf7962b5e70a5cb7a83d724c01f8317c7',
                  'opengauss':'744782c5c2aff0cbd27aecafc4b6315bf7962b5e70a5cb7a83d724c01f8317c7',
                  'clickhouse':'05c7503ad233eef1d57f08f415632b95643813c11896fd19f002c275540c6733'}
        for backend,digest in expected.items():
            self.assertEqual(digest, hashlib.sha256((SCHEMA/backend/'001_core.sql').read_bytes()).hexdigest(),backend)


class IamSchemaTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript((SCHEMA/'sqlite/001_core.sql').read_text())
        migration=SCHEMA/'sqlite/002_iam.sql'
        self.assertTrue(migration.exists(),'IAM migration required')
        self.db.executescript(migration.read_text())
        self.db.execute("INSERT INTO workspaces VALUES ('w','Workspace','active',0,0)")
        for name in ('one','two','third'):
            self.db.execute('INSERT INTO iam_principals(principal_id,normalized_login_name,display_name,created_at_ms,updated_at_ms) VALUES (?,?,?,0,0)', (name,name,name))
        self.db.execute("INSERT INTO iam_groups(group_id,group_key,name,created_by,created_at_ms,updated_at_ms) VALUES ('g','group','Group','one',0,0)")
        self.db.execute("INSERT INTO iam_group_memberships(group_id,principal_id,role,created_at_ms,updated_at_ms) VALUES ('g','one','owner',0,0)")
        self.db.execute("INSERT INTO iam_workspace_bindings(workspace_id,owner_type,owner_group_id,created_at_ms,updated_at_ms) VALUES ('w','group','g',0,0)")

    def tearDown(self):self.db.close()

    def test_catalog_matches_10_tables_and_columns(self):
        tables=json.loads((SCHEMA/'iam-catalog.json').read_text())['tables']
        self.assertEqual(10,len(tables))
        names={r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'iam_%'")}
        self.assertEqual({t['name'] for t in tables},names)
        for table in tables:
            info=list(self.db.execute('PRAGMA table_info('+table['name']+')'))
            self.assertEqual([c['name'] for c in table['columns']],[r[1] for r in info])
        self.assertEqual([],list(self.db.execute('PRAGMA foreign_key_check')))

    def test_normalized_login_and_external_identity_unique(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO iam_principals VALUES ('duplicate','one','Duplicate','active',1,0,0)")
        self.db.execute("INSERT INTO iam_external_identities VALUES ('ext1','one','oidc','issuer','subject',0)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO iam_external_identities VALUES ('ext2','two','oidc','issuer','subject',0)")

    def test_hashes_are_lowercase_64_hex_and_credentials_unique(self):
        token='a'*64
        self.db.execute("INSERT INTO iam_password_credentials VALUES ('one',?,'pbkdf2_sha256','{}',1,0)",(token,))
        self.db.execute("INSERT INTO iam_api_credentials(credential_id,principal_id,workspace_id,token_hash,capabilities_json,auth_version,issued_at_ms,expires_at_ms) VALUES ('key','one','w',?,'[]',1,0,100)",(token,))
        for value in ('A'*64,'g'*64,'a'*63):
            with self.subTest(value=value),self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE iam_password_credentials SET password_hash=?",(value,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO iam_api_credentials(credential_id,principal_id,workspace_id,token_hash,capabilities_json,auth_version,issued_at_ms,expires_at_ms) VALUES ('key2','two','w',?,'[]',1,0,100)",(token,))

    def test_session_expiry_revisions_and_integer_types(self):
        token='b'*64
        self.db.execute("INSERT INTO iam_sessions VALUES ('session','one',?,1,10,100,NULL)",(token,))
        for assignment in ('auth_version=0','issued_at_ms=-1','expires_at_ms=9','revoked_at_ms=1',"auth_version='bad'"):
            with self.subTest(assignment=assignment),self.assertRaises(sqlite3.IntegrityError):
                self.db.execute('UPDATE iam_sessions SET '+assignment)

    def test_last_owner_cannot_disable_demote_delete_membership(self):
        for sql in ("UPDATE iam_group_memberships SET role='member' WHERE principal_id='one'", "UPDATE iam_group_memberships SET status='disabled' WHERE principal_id='one'", "DELETE FROM iam_group_memberships WHERE principal_id='one'"):
            with self.subTest(sql=sql),self.assertRaises(sqlite3.IntegrityError):self.db.execute(sql)

    def test_last_owner_principal_cannot_disable(self):
        with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE iam_principals SET status='disabled' WHERE principal_id='one'")
        self.db.execute("INSERT INTO iam_group_memberships(group_id,principal_id,role,created_at_ms,updated_at_ms) VALUES ('g','two','owner',0,0)")
        self.db.execute("UPDATE iam_principals SET status='disabled' WHERE principal_id='one'")
        with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE iam_principals SET status='disabled' WHERE principal_id='two'")

    def test_multiple_owners_allow_one_demotion_and_bump_revision(self):
        before=self.db.execute("SELECT policy_revision FROM iam_groups WHERE group_id='g'").fetchone()[0]
        self.db.execute("INSERT INTO iam_group_memberships(group_id,principal_id,role,created_at_ms,updated_at_ms) VALUES ('g','two','owner',0,0)")
        self.db.execute("UPDATE iam_group_memberships SET role='admin' WHERE principal_id='one'")
        after=self.db.execute("SELECT policy_revision FROM iam_groups WHERE group_id='g'").fetchone()[0]
        self.assertGreaterEqual(after,before+2)
        with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE iam_group_memberships SET role='admin' WHERE principal_id='two'")

    def test_inactive_group_allows_owner_removal(self):
        self.db.execute("UPDATE iam_groups SET status='disabled' WHERE group_id='g'")
        self.db.execute("DELETE FROM iam_group_memberships WHERE principal_id='one'")
        with self.assertRaises(sqlite3.IntegrityError):self.db.execute("UPDATE iam_groups SET status='active' WHERE group_id='g'")

    def test_workspace_binding_xor_and_ownership_immutable(self):
        for assignment in ("owner_principal_id='one'", "owner_type='personal'", "owner_group_id='missing'"):
            with self.subTest(assignment=assignment),self.assertRaises(sqlite3.IntegrityError):
                self.db.execute('UPDATE iam_workspace_bindings SET '+assignment)
        with self.assertRaises(sqlite3.IntegrityError):self.db.execute("DELETE FROM iam_workspace_bindings")
        self.db.execute("UPDATE iam_workspace_bindings SET binding_revision=2,updated_at_ms=1")

    def test_resource_grants_are_scoped_to_existing_resource_and_principal(self):
        self.db.execute("INSERT INTO iam_resource_access VALUES ('w','trace','trace1','one','private',1,0,0)")
        self.db.execute("INSERT INTO iam_resource_grants VALUES ('w','trace','trace1','two',0)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO iam_resource_grants VALUES ('w','trace','other','two',0)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO iam_resource_grants VALUES ('w','trace','trace1','missing',0)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO iam_resource_access VALUES ('w','unknown','x','one','private',1,0,0)")

    def test_lookup_indexes_exist(self):
        self.assertIn('idx_iam_api_credentials_principal_scope',{r[1] for r in self.db.execute("PRAGMA index_list('iam_api_credentials')")})
        self.assertIn('idx_iam_group_memberships_principal',{r[1] for r in self.db.execute("PRAGMA index_list('iam_group_memberships')")})
        self.assertIn('idx_iam_resource_access_owner',{r[1] for r in self.db.execute("PRAGMA index_list('iam_resource_access')")})


@unittest.skipUnless(os.environ.get('STORAGE_TEST_PG_CONTAINER'),'set STORAGE_TEST_PG_CONTAINER for real IAM PostgreSQL contracts')
class IamPostgresSchemaTest(unittest.TestCase):
    def test_concurrent_last_owner_guard_read_committed_and_repeatable_read(self):
        container=os.environ['STORAGE_TEST_PG_CONTAINER']
        self.assertRegex(container,r'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')
        schema='storage_iam_race_'+uuid.uuid4().hex
        command=['docker','exec','-i',container,'psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
        def sql(text):
            result=subprocess.run(command,input=text,text=True,capture_output=True,timeout=30)
            self.assertEqual(0,result.returncode,result.stderr)
            return result.stdout.strip()
        def ready(process):
            for _ in range(5):
                line=process.stdout.readline().strip()
                if line=='READY':return
                if not line and process.poll() is not None:break
            self.fail('PostgreSQL session failed readiness: '+process.stderr.read())
        prepare='CREATE SCHEMA '+schema+'; SET search_path TO '+schema+';\n'
        prepare+=(SCHEMA/'postgresql/001_core.sql').read_text()+'\n'+(SCHEMA/'postgresql/002_iam.sql').read_text()
        prepare+="\nINSERT INTO workspaces VALUES ('w','Workspace','active',0,0); INSERT INTO iam_principals(principal_id,normalized_login_name,display_name,created_at_ms,updated_at_ms) VALUES ('one','one','One',0,0),('two','two','Two',0,0); INSERT INTO iam_groups(group_id,group_key,name,created_by,created_at_ms,updated_at_ms) VALUES ('g','group','Group','one',0,0); INSERT INTO iam_group_memberships(group_id,principal_id,role,created_at_ms,updated_at_ms) VALUES ('g','one','owner',0,0),('g','two','owner',0,0);"
        try:
            sql(prepare)
            for isolation,expected_state in [('READ COMMITTED','P0001'),('REPEATABLE READ','40001')]:
                with self.subTest(isolation=isolation):
                    sql('SET search_path TO '+schema+"; UPDATE iam_group_memberships SET role='owner';")
                    first=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
                    second=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
                    app='owner_guard_'+uuid.uuid4().hex
                    try:
                        for process in (first,second):
                            process.stdin.write('BEGIN ISOLATION LEVEL '+isolation+'; SET LOCAL search_path TO '+schema+"; SELECT COUNT(*) FROM iam_group_memberships; SELECT 'READY';\n")
                            process.stdin.flush()
                            ready(process)
                        first.stdin.write("UPDATE iam_group_memberships SET role='admin' WHERE principal_id='one'; SELECT 'READY';\n")
                        first.stdin.flush();ready(first)
                        second.stdin.write("SET LOCAL application_name='"+app+"'; UPDATE iam_group_memberships SET role='admin' WHERE principal_id='two'; COMMIT;\n\\q\n")
                        second.stdin.flush()
                        deadline=time.monotonic()+10
                        blocked=False
                        while time.monotonic()<deadline:
                            blocked=sql("SELECT COUNT(*) FROM pg_stat_activity WHERE application_name='"+app+"' AND wait_event_type='Lock';")=='1'
                            if blocked:break
                            if second.poll() is not None:break
                            time.sleep(0.01)
                        self.assertTrue(blocked,'second owner update must wait on the group row')
                        first.stdin.write('COMMIT;\n\\q\n');first.stdin.flush()
                        _,first_errors=first.communicate(timeout=20)
                        self.assertEqual(0,first.returncode,first_errors)
                        _,second_errors=second.communicate(timeout=20)
                        self.assertNotEqual(0,second.returncode)
                        self.assertIn(expected_state,second_errors)
                        remaining=sql('SET search_path TO '+schema+"; SELECT COUNT(*) FROM iam_group_memberships m JOIN iam_principals p ON p.principal_id=m.principal_id WHERE m.group_id='g' AND m.role='owner' AND m.status='active' AND p.status='active';")
                        self.assertEqual('1',remaining)
                    finally:
                        for process in (first,second):
                            if process.poll() is None:
                                process.kill();process.communicate(timeout=10)
        finally:
            sql('DROP SCHEMA IF EXISTS '+schema+' CASCADE;')

    def test_real_postgres_iam_constraints(self):
        container=os.environ['STORAGE_TEST_PG_CONTAINER']
        self.assertRegex(container,r'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')
        schema='storage_iam_contract_'+uuid.uuid4().hex
        sql='BEGIN;\nCREATE SCHEMA '+schema+';\nSET LOCAL search_path TO '+schema+';\n'
        sql+=(SCHEMA/'postgresql/001_core.sql').read_text()+'\n'+(SCHEMA/'postgresql/002_iam.sql').read_text()
        sql+=r"""
CREATE FUNCTION assert_rejected(statement TEXT, expected_state TEXT) RETURNS void AS $$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected_state THEN rejected:=true; ELSE RAISE; END IF;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'statement unexpectedly succeeded'; END IF;
END; $$ LANGUAGE plpgsql;
INSERT INTO workspaces VALUES ('w','Workspace','active',0,0);
INSERT INTO iam_principals(principal_id,normalized_login_name,display_name,created_at_ms,updated_at_ms) VALUES ('one','one','One',0,0),('two','two','Two',0,0);
SELECT assert_rejected($s$INSERT INTO iam_principals VALUES ('duplicate','one','Name','active',1,0,0)$s$,'23505');
INSERT INTO iam_password_credentials VALUES ('one',repeat('a',64),'pbkdf2_sha256','{}',1,0);
SELECT assert_rejected($s$UPDATE iam_password_credentials SET password_hash=repeat('A',64)$s$,'23514');
INSERT INTO iam_sessions VALUES ('session','one',repeat('b',64),1,10,100,NULL);
SELECT assert_rejected($s$UPDATE iam_sessions SET expires_at_ms=1$s$,'23514');
INSERT INTO iam_groups(group_id,group_key,name,created_by,created_at_ms,updated_at_ms) VALUES ('g','group','Group','one',0,0);
INSERT INTO iam_group_memberships(group_id,principal_id,role,created_at_ms,updated_at_ms) VALUES ('g','one','owner',0,0);
SELECT assert_rejected($s$UPDATE iam_group_memberships SET role='member' WHERE principal_id='one'$s$,'P0001');
SELECT assert_rejected($s$DELETE FROM iam_group_memberships WHERE principal_id='one'$s$,'P0001');
SELECT assert_rejected($s$UPDATE iam_principals SET status='disabled' WHERE principal_id='one'$s$,'P0001');
INSERT INTO iam_group_memberships(group_id,principal_id,role,created_at_ms,updated_at_ms) VALUES ('g','two','owner',0,0);
UPDATE iam_group_memberships SET role='admin' WHERE principal_id='one';
SELECT assert_rejected($s$UPDATE iam_group_memberships SET role='admin' WHERE principal_id='two'$s$,'P0001');
SELECT assert_rejected($s$UPDATE iam_principals SET status='disabled' WHERE principal_id='two'$s$,'P0001');
INSERT INTO iam_workspace_bindings(workspace_id,owner_type,owner_group_id,created_at_ms,updated_at_ms) VALUES ('w','group','g',0,0);
SELECT assert_rejected($s$UPDATE iam_workspace_bindings SET owner_type='personal',owner_group_id=NULL,owner_principal_id='one'$s$,'P0001');
SELECT assert_rejected($s$DELETE FROM iam_workspace_bindings$s$,'P0001');
INSERT INTO iam_resource_access VALUES ('w','trace','trace1','one','private',1,0,0);
INSERT INTO iam_resource_grants VALUES ('w','trace','trace1','two',0);
SELECT assert_rejected($s$INSERT INTO iam_resource_grants VALUES ('w','trace','missing','two',0)$s$,'23503');
UPDATE iam_groups SET status='disabled';
DELETE FROM iam_group_memberships;
SELECT assert_rejected($s$UPDATE iam_groups SET status='active'$s$,'P0001');
SELECT 'IAM PostgreSQL schema contracts passed';
ROLLBACK;
"""
        result=subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,timeout=60)
        self.assertEqual(0,result.returncode,result.stderr)
        self.assertIn('IAM PostgreSQL schema contracts passed',result.stdout)


if __name__=='__main__':unittest.main()
