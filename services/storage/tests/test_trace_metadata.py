import importlib
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path

from services.storage.control import SQLiteControlStore, Conflict, StorageError
from services.storage.iam import IAMStore, Forbidden
from services.storage.authorized import AuthorizedStorage


class TraceMetadataTests(unittest.TestCase):
    def make_control(self):
        return SQLiteControlStore(Path(self.temp.name)/'db',clock=lambda:self.now)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.now=100000
        self.control=self.make_control();self.control.initialize();self.iam=IAMStore(self.control)
        for p in ('admin','alice','bob','viewer'):self.iam.create_principal(p,p,p)
        self.iam.create_group('g','group','Group','admin')
        for p in ('alice','bob'):self.iam.set_membership_for_provisioning('g',p,'member')
        self.iam.set_membership_for_provisioning('g','viewer','viewer')
        for w in ('w','foreign'):self.control.create_workspace(w,w)
        self.iam.bind_workspace('w',group_id='g');self.iam.bind_workspace('foreign',principal_id='bob')
        self.tokens={p:self.iam.issue_session_for_provisioning(p) for p in ('admin','alice','bob','viewer')}
        auth=AuthorizedStorage(self.iam,None)
        auth.create_trace(self.tokens['alice'],'w','trace','2026-11-12',source_namespace='otlp',native_trace_id='native')
        auth.create_trace(self.tokens['bob'],'w','other','2026-11-12',source_namespace='otlp',native_trace_id='other')
        self.meta=importlib.import_module('services.storage.trace_metadata').TraceMetadata(self.control)

    def rows(self,table):
        with self.control.read_transaction() as con:return [dict(r) for r in con.execute('SELECT * FROM '+table)]

    def tag(self,token='alice',**payload):
        return self.meta.create_tag(self.tokens[token],'w',dict({'name':'tag','kind':'business'},**payload))

    def test_aliases_are_idempotent_stable_first_and_tenant_scoped(self):
        self.meta.register_aliases_for_provisioning('w','trace',task_id='z-first',execution_id='upload-old')
        self.meta.register_aliases_for_provisioning('w','trace',task_id='a-second')
        self.meta.register_aliases_for_provisioning('w','trace',task_id='z-first')
        result=self.meta.resolve(self.tokens['alice'],'w','a-second')
        self.assertEqual(result,{'trace_id':'trace','task_id':'z-first','execution_id':'upload-old'})
        self.assertEqual(self.meta.resolve(self.tokens['alice'],'w','upload-old','execution'),result)
        self.assertEqual(self.meta.resolve(self.tokens['alice'],'w','trace'),result)
        with self.assertRaises(Conflict):self.meta.register_aliases_for_provisioning('w','other',task_id='z-first')
        with self.assertRaises(Forbidden):self.meta.resolve(self.tokens['bob'],'w','z-first')
        with self.assertRaises(Forbidden):self.meta.resolve(self.tokens['alice'],'foreign','z-first')
        self.assertEqual(len(self.rows('trace_legacy_ids')),3)

    def test_alias_mapping_cannot_be_rewritten_or_deleted(self):
        self.meta.register_aliases_for_provisioning('w','trace',task_id='legacy')
        for sql in ("UPDATE trace_legacy_ids SET trace_id='other'","DELETE FROM trace_legacy_ids"):
            with self.subTest(sql=sql),self.assertRaises(StorageError):
                with self.control.transaction() as con:con.execute(sql)

    def test_patch_cas_keeps_raw_sources_and_nullable_override_semantics(self):
        original=self.meta.properties(self.tokens['alice'],'w','trace');self.assertEqual(original['revision'],0)
        props=self.meta.patch(self.tokens['alice'],'w','trace',{'label':'Label','query':'Question','final_result':'Answer','user_feedback':{'score':0.5}},expected_revision=0)
        self.assertEqual(props['revision'],1);self.assertEqual(props['query_override'],'Question')
        self.assertEqual(props['user_feedback'],{'score':0.5})
        self.assertEqual(self.meta.patch(self.tokens['alice'],'w','trace',{'label':'Label'},expected_revision=1)['revision'],1)
        with self.assertRaises(Conflict):self.meta.patch(self.tokens['alice'],'w','trace',{'label':'stale'},expected_revision=0)
        cleared=self.meta.patch(self.tokens['alice'],'w','trace',{'query':None},expected_revision=1)
        self.assertIsNone(cleared['query_override']);self.assertEqual(cleared['revision'],2)
        self.assertEqual(self.rows('obs_entity_heads'),[])
        with self.assertRaises(ValueError):self.meta.patch(self.tokens['alice'],'w','trace',{'trace_id':'other'})

    def test_shared_read_never_grants_annotation_or_tag_writes(self):
        self.iam.share_resource(self.tokens['alice'],'w','trace','trace','bob')
        self.meta.properties(self.tokens['bob'],'w','trace')
        for token in ('bob','viewer'):
            with self.subTest(token=token),self.assertRaises(Forbidden):self.meta.patch(self.tokens[token],'w','trace',{'label':'no'})
        self.meta.patch(self.tokens['admin'],'w','trace',{'label':'admin'})
        with self.assertRaises(Forbidden):self.meta.patch(self.tokens['alice'],'foreign','trace',{'label':'no'})

    def test_tags_old_dto_ownership_uniqueness_and_cas(self):
        tag=self.tag(name=' release ',color='#ABCDEF')
        self.assertEqual(tag['name'],'release');self.assertEqual(tag['color'],'#abcdef');self.assertEqual(tag['usageCount'],0)
        self.assertEqual(tag['createdBy'],'alice');self.assertEqual(tag['revision'],1)
        with self.assertRaises(Conflict):self.tag(name='release')
        other=self.tag('bob',name='release')
        self.assertEqual([t['id'] for t in self.meta.list_tags(self.tokens['alice'],'w')],[tag['id']])
        self.assertEqual(len(self.meta.list_tags(self.tokens['admin'],'w')),2)
        with self.assertRaises(Forbidden):self.meta.update_tag(self.tokens['bob'],'w',tag['id'],{'name':'stolen'})
        changed=self.meta.update_tag(self.tokens['alice'],'w',tag['id'],{'name':'new'},expected_revision=1)
        self.assertEqual(changed['revision'],2)
        with self.assertRaises(Conflict):self.meta.update_tag(self.tokens['alice'],'w',tag['id'],{'name':'old'},expected_revision=1)
        self.assertTrue(self.meta.delete_tag(self.tokens['bob'],'w',other['id']))
        self.assertFalse(self.meta.delete_tag(self.tokens['bob'],'w',other['id']))

    def test_tag_links_atomic_deduplicated_read_visibility_and_usage(self):
        tag=self.tag(name='business');second=self.tag(name='version',kind='version')
        self.assertEqual(len(self.meta.add_trace_tags(self.tokens['alice'],'w','trace',[tag['id'],tag['id']])),1)
        with self.assertRaises(Forbidden):self.meta.replace_trace_tags(self.tokens['alice'],'w','trace',[second['id'],'missing'])
        self.assertEqual([t['id'] for t in self.meta.get_trace_tags(self.tokens['alice'],'w','trace')],[tag['id']])
        self.assertEqual(next(t for t in self.meta.list_tags(self.tokens['alice'],'w') if t['id']==tag['id'])['usageCount'],1)
        self.iam.share_resource(self.tokens['alice'],'w','trace','trace','bob')
        visible=self.meta.list_tags(self.tokens['bob'],'w')
        self.assertEqual([t['id'] for t in visible],[tag['id']]);self.assertEqual(visible[0]['usageCount'],1)
        with self.assertRaises(Forbidden):self.meta.add_trace_tags(self.tokens['bob'],'w','other',[tag['id']])
        self.assertEqual(self.meta.replace_trace_tags(self.tokens['alice'],'w','trace',[second['id']])[0]['id'],second['id'])
        self.assertEqual(self.meta.remove_trace_tag(self.tokens['alice'],'w','trace',second['id']),[])

    def test_delete_is_idempotent_authorized_durable_and_filters_reads_counts(self):
        tag=self.tag();self.meta.add_trace_tags(self.tokens['alice'],'w','trace',[tag['id']])
        self.meta.register_aliases_for_provisioning('w','trace',task_id='task')
        self.iam.share_resource(self.tokens['alice'],'w','trace','trace','bob')
        with self.assertRaises(Forbidden):self.meta.delete(self.tokens['bob'],'w','trace')
        self.assertTrue(self.meta.delete(self.tokens['alice'],'w','trace'))
        self.assertFalse(self.meta.delete(self.tokens['alice'],'w','trace'))
        self.assertEqual(next(r for r in self.rows('trace_locators') if r['trace_id']=='trace')['state'],'deleting')
        self.assertEqual(len(self.rows('deletion_requests')),1)
        self.assertEqual(len(self.rows('trace_legacy_ids')),1)
        self.assertEqual(self.meta.list_tags(self.tokens['alice'],'w')[0]['usageCount'],0)
        for method,args in [(self.meta.resolve,('task',)),(self.meta.properties,('trace',)),(self.meta.get_trace_tags,('trace',))]:
            with self.subTest(method=method.__name__),self.assertRaises(Forbidden):method(self.tokens['alice'],'w',*args)

    def test_tag_delete_removes_links_without_deleting_trace(self):
        tag=self.tag();self.meta.add_trace_tags(self.tokens['alice'],'w','trace',[tag['id']])
        self.assertTrue(self.meta.delete_tag(self.tokens['alice'],'w',tag['id']))
        self.assertEqual(self.rows('trace_tag_links'),[])
        self.assertEqual(next(r for r in self.rows('trace_locators') if r['trace_id']=='trace')['state'],'active')

    def test_write_api_credential_cannot_delete_own_trace_or_tag(self):
        tag=self.tag()
        token=self.iam.issue_api_credential(self.tokens['alice'],'w',['read','write'])
        with self.assertRaises(Forbidden):self.meta.delete(token,'w','trace')
        with self.assertRaises(Forbidden):self.meta.delete_tag(token,'w',tag['id'])
        self.assertEqual(next(r for r in self.rows('trace_locators') if r['trace_id']=='trace')['state'],'active')
        self.assertEqual(len(self.rows('trace_tags')),1)
        self.assertEqual(self.rows('deletion_requests'),[])

    def test_member_delete_capability_keeps_session_and_explicit_api_deletion(self):
        tag=self.tag()
        token=self.iam.issue_api_credential(self.tokens['alice'],'w',['delete'])
        self.assertTrue(self.meta.delete_tag(token,'w',tag['id']))
        self.assertTrue(self.meta.delete(self.tokens['alice'],'w','trace'))

    def test_delete_never_grants_member_or_viewer_another_owners_resource(self):
        tag=self.tag()
        self.iam.share_resource(self.tokens['alice'],'w','trace','trace','bob')
        for actor in ('bob','viewer'):
            with self.subTest(actor=actor),self.assertRaises(Forbidden):self.meta.delete(self.tokens[actor],'w','trace')
            with self.subTest(actor=actor),self.assertRaises(Forbidden):self.meta.delete_tag(self.tokens[actor],'w',tag['id'])
        self.assertEqual(next(r for r in self.rows('trace_locators') if r['trace_id']=='trace')['state'],'active')
        self.assertEqual(len(self.rows('trace_tags')),1)

    def test_current_revocation_blocks_every_metadata_path(self):
        tag=self.tag()
        self.iam.set_membership(self.tokens['admin'],'g','alice','member',status='disabled',expected_etag=1)
        calls=[(self.meta.properties,('trace',)),(self.meta.resolve,('trace',)),(self.meta.list_tags,()),(self.meta.get_trace_tags,('trace',)),(self.meta.patch,('trace',{'label':'no'})),(self.meta.delete,('trace',)),(self.meta.create_tag,({'name':'new','kind':'version'},))]
        for method,args in calls:
            with self.subTest(method=method.__name__),self.assertRaises(Forbidden):method(self.tokens['alice'],'w',*args)

    def test_override_fields_distinguish_absent_and_explicit_null(self):
        self.assertEqual(self.meta.properties(self.tokens['alice'],'w','trace')['override_fields'],[])
        first=self.meta.patch(self.tokens['alice'],'w','trace',{'label':'x'},expected_revision=0)
        self.assertEqual(first['override_fields'],['label'])
        cleared=self.meta.patch(self.tokens['alice'],'w','trace',{'query':None},expected_revision=1)
        self.assertEqual(cleared['override_fields'],['label','query'])
        self.assertEqual(cleared['revision'],2)
        self.assertEqual(self.meta.patch(self.tokens['alice'],'w','trace',{'query':None},expected_revision=2)['revision'],2)
        self.assertEqual(json.loads(self.rows('trace_annotations')[0]['extra_json'])['override_fields'],['label','query'])

    def test_repeat_replace_keeps_original_link_provenance_and_time(self):
        tag=self.tag()
        self.meta.replace_trace_tags(self.tokens['alice'],'w','trace',[tag['id']])
        before=self.rows('trace_tag_links');self.now+=1000
        self.meta.replace_trace_tags(self.tokens['admin'],'w','trace',[tag['id']])
        self.assertEqual(self.rows('trace_tag_links'),before)

    def test_concurrent_annotation_cas_has_one_winner(self):
        import concurrent.futures
        def edit(value):
            try:return self.meta.patch(self.tokens['alice'],'w','trace',{'label':value},expected_revision=0)['revision']
            except Conflict:return 'conflict'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(edit,['one','two']))
        self.assertCountEqual(results,[1,'conflict'])
        self.assertEqual(len(self.rows('trace_annotations')),1)

    def test_alias_pair_collision_rolls_back_both_and_preserves_legacy_bytes(self):
        self.meta.register_aliases_for_provisioning('w','other',execution_id='taken')
        with self.assertRaises(Conflict):self.meta.register_aliases_for_provisioning('w','trace',task_id='fresh',execution_id='taken')
        self.assertEqual(len(self.rows('trace_legacy_ids')),1)
        legacy=' legacy '+('x'*600)
        self.meta.register_aliases_for_provisioning('w','trace',task_id=legacy)
        self.assertEqual(self.meta.resolve(self.tokens['alice'],'w',legacy)['task_id'],legacy)

    def test_write_only_token_does_not_receive_read_usage_counts(self):
        tag=self.tag('admin')
        self.meta.add_trace_tags(self.tokens['admin'],'w','trace',[tag['id']])
        token=self.iam.issue_api_credential(self.tokens['admin'],'w',['write'])
        changed=self.meta.update_tag(token,'w',tag['id'],{'name':'new'})
        self.assertEqual(changed['usageCount'],0)
        with self.assertRaises(Forbidden):self.meta.list_tags(token,'w')

    def test_catalog_columns_constraints_and_additive_migration(self):
        root=Path(__file__).parents[1]/'schema';catalog=json.loads((root/'metadata-catalog.json').read_text())
        self.assertEqual(catalog['version'],5);self.assertEqual(len(catalog['tables']),4)
        with self.control.read_transaction() as con:
            for table in catalog['tables']:
                if isinstance(self.control,SQLiteControlStore):actual=[r['name'] for r in con.execute('PRAGMA table_info('+table['name']+')')]
                else:actual=[r[0] for r in con.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',(self.control.schema,table['name']))]
                self.assertEqual(actual,[c['name'] for c in table['columns']])
        for backend in ('sqlite','postgresql','opengauss'):self.assertTrue((root/backend/'005_trace_metadata.sql').is_file())
        self.meta.patch(self.tokens['alice'],'w','trace',{'label':'x'})
        tag=self.tag();self.meta.add_trace_tags(self.tokens['alice'],'w','trace',[tag['id']])
        for sql in ("UPDATE trace_annotations SET revision=0","UPDATE trace_annotations SET updated_at_ms=-1","UPDATE trace_annotations SET trace_id='missing'","UPDATE trace_tags SET kind='other'","UPDATE trace_tags SET owner_principal_id='missing'","UPDATE trace_tag_links SET workspace_id='foreign'"):
            with self.subTest(sql=sql),self.assertRaises(StorageError):
                with self.control.transaction() as con:con.execute(sql)


@unittest.skipUnless(os.environ.get('STORAGE_METADATA_PG_CONFIG'),'optional isolated PostgreSQL config required')
class PostgreSQLTraceMetadataTests(TraceMetadataTests):
    def make_control(self):
        import psycopg2
        from services.storage.relational import PostgreSQLControlStore
        config=json.loads(Path(os.environ['STORAGE_METADATA_PG_CONFIG']).read_text());schema='metadata_test_'+uuid.uuid4().hex
        factory=lambda:psycopg2.connect(config['dsn']) if 'dsn' in config else psycopg2.connect(**config)
        def clean():
            with factory() as con:
                with con.cursor() as cursor:cursor.execute('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')
        self.addCleanup(clean)
        return PostgreSQLControlStore(factory,schema=schema,artifact_directory=Path(self.temp.name)/'artifacts',clock=lambda:self.now)


if __name__=='__main__':unittest.main()
