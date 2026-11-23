import hashlib
import json
import os
import re
import sqlite3
import subprocess
import unittest
import uuid
from pathlib import Path

SCHEMA=Path(__file__).resolve().parents[1]/'schema'


class ProjectSchemaFilesTest(unittest.TestCase):
    def test_additive_project_baseline_files_exist(self):
        for backend in ('sqlite','postgresql','opengauss'):
            self.assertTrue((SCHEMA/backend/'003_projects.sql').is_file(),backend)

    def test_existing_001_and_002_bytes_remain_immutable(self):
        expected={
            'clickhouse/001_core.sql':'05c7503ad233eef1d57f08f415632b95643813c11896fd19f002c275540c6733',
            'sqlite/001_core.sql':'a534293881ac948d3e81f24f9af3449201f88245ef7661154751d63024a4b65f',
            'postgresql/001_core.sql':'744782c5c2aff0cbd27aecafc4b6315bf7962b5e70a5cb7a83d724c01f8317c7',
            'opengauss/001_core.sql':'744782c5c2aff0cbd27aecafc4b6315bf7962b5e70a5cb7a83d724c01f8317c7',
            'sqlite/002_iam.sql':'773a3b5ee8bb3b32e608b8b4c140804199e7531e5383e1e38727c8084b9511b0',
            'postgresql/002_iam.sql':'dad21e112461836f8b87a67168ce10272fcb48c1011c69ace33a976b5641c3eb',
            'opengauss/002_iam.sql':'dad21e112461836f8b87a67168ce10272fcb48c1011c69ace33a976b5641c3eb',
        }
        for relative,digest in expected.items():
            self.assertEqual(digest,hashlib.sha256((SCHEMA/relative).read_bytes()).hexdigest(),relative)


class ProjectSchemaTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.execute('PRAGMA foreign_keys=ON')
        for migration in ('001_core.sql','002_iam.sql'):
            self.db.executescript((SCHEMA/'sqlite'/migration).read_text())
        for workspace in ('w','other'):
            self.db.execute("INSERT INTO workspaces VALUES (?,?,'active',7,9)",(workspace,workspace))
        p=SCHEMA/'sqlite/003_projects.sql'
        self.assertTrue(p.exists(),'project migration required')
        self.db.executescript(p.read_text())

    def tearDown(self):self.db.close()

    def test_default_seed_and_backfill_preserve_workspace_ids(self):
        self.assertEqual([('default','default','active',0,0)],list(self.db.execute('SELECT * FROM projects')))
        self.assertEqual([('other','default',7),('w','default',7)],list(self.db.execute('SELECT * FROM project_workspaces ORDER BY workspace_id')))
        self.assertEqual([('other','other','active',7,9),('w','w','active',7,9)],list(self.db.execute('SELECT * FROM workspaces ORDER BY workspace_id')))
        self.assertEqual([],list(self.db.execute('PRAGMA foreign_key_check')))
        self.assertEqual(0,self.db.execute('SELECT COUNT(*) FROM iam_principals').fetchone()[0])
        self.assertEqual(0,self.db.execute('SELECT COUNT(*) FROM iam_resource_access').fetchone()[0])

    def test_existing_workspace_ids_are_not_revalidated_or_normalized(self):
        legacy=sqlite3.connect(':memory:')
        ids=(' legacy ','x'*600,'control\x00id','')
        try:
            legacy.execute('PRAGMA foreign_keys=ON')
            for filename in ('001_core.sql','002_iam.sql'):
                legacy.executescript((SCHEMA/'sqlite'/filename).read_text())
            for workspace in ids:
                legacy.execute("INSERT INTO workspaces VALUES (?,'Legacy','active',13,17)",(workspace,))
            legacy.executescript((SCHEMA/'sqlite/003_projects.sql').read_text())
            actual={r[0] for r in legacy.execute('SELECT workspace_id FROM project_workspaces')}
            self.assertEqual(set(ids),actual)
            self.assertEqual([(13,)],list(legacy.execute('SELECT DISTINCT created_at_ms FROM project_workspaces')))
            self.assertEqual([],list(legacy.execute('PRAGMA foreign_key_check')))
        finally:legacy.close()

    def test_catalog_and_backend_ddl_table_sets(self):
        catalog=json.loads((SCHEMA/'project-catalog.json').read_text())
        self.assertEqual(3,catalog['version']);self.assertEqual('projects',catalog['name'])
        self.assertEqual(2,len(catalog['tables']))
        expected={t['name'] for t in catalog['tables']}
        for backend in ('sqlite','postgresql','opengauss'):
            sql=(SCHEMA/backend/'003_projects.sql').read_text()
            self.assertEqual(expected,set(re.findall(r'^CREATE TABLE ([a-z_]+)',sql,re.M)))
        for t in catalog['tables']:
            self.assertEqual([c['name'] for c in t['columns']],[r[1] for r in self.db.execute('PRAGMA table_info('+t['name']+')')])

    def test_mapping_requires_existing_workspace_and_project(self):
        self.db.execute("INSERT INTO workspaces VALUES ('new','New','active',0,0)")
        for values in [('new','missing',0),('missing','default',0)]:
            with self.subTest(values=values),self.assertRaises(sqlite3.IntegrityError):
                self.db.execute('INSERT INTO project_workspaces VALUES (?,?,?)',values)
        self.db.execute("INSERT INTO projects VALUES ('next','Next','active',0,0)")
        self.db.execute("INSERT INTO project_workspaces VALUES ('new','next',0)")

    def test_bindings_are_immutable_and_default_identity_protected(self):
        self.db.execute("INSERT INTO projects VALUES ('next','Next','active',0,0)")
        for sql in ("UPDATE project_workspaces SET project_id='next'", "UPDATE project_workspaces SET created_at_ms=99", "DELETE FROM project_workspaces", "UPDATE projects SET project_id='renamed' WHERE project_id='default'", "DELETE FROM projects WHERE project_id='default'"):
            with self.subTest(sql=sql),self.assertRaises(sqlite3.IntegrityError):self.db.execute(sql)
        self.db.execute("UPDATE projects SET name='Default renamed',status='disabled' WHERE project_id='default'")
        self.assertEqual('disabled',self.db.execute("SELECT status FROM projects WHERE project_id='default'").fetchone()[0])

    def test_project_fields_and_integer_timestamp_constraints(self):
        for value in ('',' padded','padded ','x'*513,'a\x00b','a\x1fb','a\x7fb','a\x80b','a\x9fb'):
            with self.subTest(value=value),self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("INSERT INTO projects VALUES (?, 'Name','active',0,0)",(value,))
        for assignment in ("name=''", "status='unknown'", 'created_at_ms=-1',"updated_at_ms='bad'",'updated_at_ms=0.5'):
            with self.subTest(assignment=assignment),self.assertRaises(sqlite3.IntegrityError):
                self.db.execute('UPDATE projects SET '+assignment+" WHERE project_id='default'")

    def test_default_delete_is_guarded_without_workspace_references(self):
        empty=sqlite3.connect(':memory:')
        try:
            empty.execute('PRAGMA foreign_keys=ON')
            for filename in ('001_core.sql','002_iam.sql','003_projects.sql'):
                empty.executescript((SCHEMA/'sqlite'/filename).read_text())
            self.assertEqual(0,empty.execute('SELECT COUNT(*) FROM project_workspaces').fetchone()[0])
            with self.assertRaises(sqlite3.IntegrityError):empty.execute("DELETE FROM projects WHERE project_id='default'")
            with self.assertRaises(sqlite3.IntegrityError):empty.execute("UPDATE projects SET project_id='renamed' WHERE project_id='default'")
        finally:empty.close()

    def test_project_workspace_lookup_index(self):
        indexes={r[1] for r in self.db.execute("PRAGMA index_list('project_workspaces')")}
        self.assertIn('idx_project_workspaces_project',indexes)
        details=list(self.db.execute('PRAGMA index_info(idx_project_workspaces_project)'))
        self.assertEqual(['project_id','workspace_id'],[r[2] for r in details])


@unittest.skipUnless(os.environ.get('STORAGE_TEST_PG_CONTAINER'),'set STORAGE_TEST_PG_CONTAINER for project PostgreSQL schema contract')
class ProjectPostgresSchemaTest(unittest.TestCase):
    def test_real_pg_default_backfill_and_immutable_mapping(self):
        container=os.environ['STORAGE_TEST_PG_CONTAINER']
        self.assertRegex(container,r'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')
        schema='storage_projects_'+uuid.uuid4().hex
        sql='BEGIN; CREATE SCHEMA '+schema+'; SET LOCAL search_path TO '+schema+';\n'
        sql+=(SCHEMA/'postgresql/001_core.sql').read_text()+'\n'+(SCHEMA/'postgresql/002_iam.sql').read_text()
        sql+="\nINSERT INTO workspaces VALUES ('w','Workspace','active',7,9),('other','Other','suspended',11,12),(' legacy ','Legacy','active',13,17), (repeat('x',600),'Long','active',19,23);\n"
        sql+=(SCHEMA/'postgresql/003_projects.sql').read_text()
        sql+=r"""
CREATE FUNCTION assert_rejected(statement TEXT, expected_state TEXT) RETURNS void AS $$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected_state THEN rejected:=true; ELSE RAISE; END IF;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'statement unexpectedly succeeded'; END IF;
END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM projects)<>1 OR (SELECT COUNT(*) FROM project_workspaces WHERE project_id='default')<>4 THEN RAISE EXCEPTION 'default backfill mismatch'; END IF;
  IF (SELECT created_at_ms FROM project_workspaces WHERE workspace_id='other')<>11 THEN RAISE EXCEPTION 'backfill timestamp mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM project_workspaces WHERE workspace_id=' legacy ' AND created_at_ms=13) OR NOT EXISTS (SELECT 1 FROM project_workspaces WHERE workspace_id=repeat('x',600) AND created_at_ms=19) THEN RAISE EXCEPTION 'legacy workspace IDs changed'; END IF;
  IF (SELECT COUNT(*) FROM iam_principals)<>0 OR (SELECT COUNT(*) FROM iam_resource_access)<>0 THEN RAISE EXCEPTION 'routing migration must not grant IAM access'; END IF;
END; $$;
INSERT INTO projects VALUES ('next','Next','active',0,0);
SELECT assert_rejected($s$UPDATE project_workspaces SET project_id='next'$s$,'P0001');
SELECT assert_rejected($s$DELETE FROM project_workspaces$s$,'P0001');
SELECT assert_rejected($s$UPDATE projects SET project_id='renamed' WHERE project_id='default'$s$,'P0001');
SELECT assert_rejected($s$DELETE FROM projects WHERE project_id='default'$s$,'P0001');
SELECT assert_rejected($s$INSERT INTO project_workspaces VALUES ('missing','default',0)$s$,'23503');
INSERT INTO workspaces VALUES ('new','New','active',0,0);
SELECT assert_rejected($s$INSERT INTO project_workspaces VALUES ('new','missing',0)$s$,'23503');
SELECT assert_rejected($s$INSERT INTO projects VALUES (' padded','Bad','active',0,0)$s$,'23514');
SELECT assert_rejected($s$INSERT INTO projects VALUES ('bad'||chr(128),'Bad','active',0,0)$s$,'23514');
UPDATE projects SET name='Renamed',status='disabled' WHERE project_id='default';
SELECT 'project schema contracts passed';
ROLLBACK;
"""
        result=subprocess.run(['docker','exec','-i',container,'psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,timeout=60)
        self.assertEqual(0,result.returncode,result.stderr)
        self.assertIn('project schema contracts passed',result.stdout)


if __name__=='__main__':unittest.main()
