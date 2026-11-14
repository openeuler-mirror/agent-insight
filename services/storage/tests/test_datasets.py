import copy
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.storage.control import SQLiteControlStore, Conflict
from services.storage.iam import IAMStore, Forbidden


def record(identity='dataset', name='Dataset'):
    return {'id': identity, 'name': name, 'description': '说明', 'targetAgent': '', 'targetSkill': 'skill',
            'tags': ['tag'], 'datasetKind': 'ideal_output', 'fields': [{'id': 'f', 'key': 'value', 'label': '值', 'type': 'json'}],
            'cases': [{'id': 'case', 'input': '问题', 'expectedOutput': '答案', 'evaluationFocus': '', 'tags': [], 'trajectory': '', 'values': {'value': {'中文': [1.25, False, None]}}}]}


class DatasetTests(unittest.TestCase):
    def make_control(self):
        return SQLiteControlStore(Path(self.tmp.name)/'db', clock=lambda: self.now)

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.now=1794441600000
        self.control=self.make_control(); self.control.initialize(); self.iam=IAMStore(self.control)
        for name in ('alice','bob','admin','viewer'): self.iam.create_principal(name,name,name)
        self.control.create_workspace('w','W'); self.iam.create_group('group','group','Group','admin'); self.iam.bind_workspace('w',group_id='group')
        self.iam.set_membership_for_provisioning('group','alice','member'); self.iam.set_membership_for_provisioning('group','bob','member'); self.iam.set_membership_for_provisioning('group','viewer','viewer')
        self.token=self.iam.issue_session_for_provisioning('alice'); self.bob=self.iam.issue_session_for_provisioning('bob'); self.admin=self.iam.issue_session_for_provisioning('admin'); self.viewer=self.iam.issue_session_for_provisioning('viewer')

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.datasets'), 'Dataset core domain must exist')
        from services.storage.datasets import DatasetStore
        return DatasetStore(self.control)

    def save(self, value=None, key='save', **options):
        return self.service().save(self.token,'w',value or record(),operation_key=key,**options)

    def test_same_name_unicode_decimal_and_actual_owner_round_trip(self):
        source=record(); source['user']='bob'; source['_storageEtag']='ignored'
        first=self.save(source); second=self.save(record('second'),key='second')
        self.assertEqual(first['dataset']['user'],'alice'); self.assertEqual(first['dataset']['cases'],source['cases'])
        self.assertEqual(first['dataset']['name'],second['dataset']['name']); self.assertEqual(first['revision'],'1'); self.assertNotIn('_storageEtag',first['dataset'])
        self.assertEqual(len(self.service().list(self.token,'w')),2)

    def test_cas_rejects_stale_save_without_new_release(self):
        first=self.save(); value=record(); value['name']='changed'; saved=self.save(value,key='update',expected_revision='1')
        with self.assertRaises(Conflict): self.save(record(),key='stale',expected_revision=1)
        self.assertEqual(saved['revision'],'2'); self.assertEqual(len(self.service().versions(self.token,'w','dataset')),2)
        self.assertNotEqual(first['release_id'],saved['release_id'])

    def test_versions_keep_original_cases_and_do_not_follow_latest(self):
        first=self.save(); value=record(); value['cases'][0]['expectedOutput']='new'; self.save(value,key='next',expected_revision=1)
        old=self.service().get(self.token,'w','dataset',version=first['release_id'])
        self.assertEqual(old['dataset']['cases'][0]['expectedOutput'],'答案'); self.assertEqual(old['revision'],'1')

    def test_receipt_exact_retry_precedes_cas_and_changed_input_conflicts(self):
        first=self.save(); self.save(record(),key='second',expected_revision=1)
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('retry must not write artifacts')):
            self.assertEqual(self.save(expected_revision=0),first)
        changed=record(); changed['name']='different'
        with self.assertRaises(Conflict): self.save(changed)

    def test_backflow_receipt_hashes_original_request_not_random_generated_ids(self):
        request={'taskIds':['trace'],'fieldMappings':[{'key':'input','source':'input'}]}
        first=self.save(record('random-one'),operation_kind='backflow',operation_request=request,operation_result={'added':1,'skipped':0})
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('committed retry must bypass preparation')):
            again=self.save(record('random-two'),operation_kind='backflow',operation_request=request,operation_result={'added':999})
        self.assertEqual(again,first); self.assertEqual(len(self.service().list(self.token,'w')),1)
        self.assertEqual(first['operation_result'],{'added':1,'skipped':0})

    def test_acl_shared_read_never_write_and_admin_reads_group(self):
        saved=self.save()
        with self.control.read_transaction() as con: asset=con.execute('SELECT asset_id FROM dataset_compat_heads').fetchone()[0]
        with self.assertRaises(Forbidden): self.service().get(self.bob,'w','dataset')
        self.iam.share_resource(self.token,'w','asset',asset,'bob')
        self.assertEqual(self.service().get(self.bob,'w','dataset')['dataset']['id'],'dataset')
        with self.assertRaises(Forbidden): self.service().save(self.bob,'w',record(),operation_key='write')
        self.assertEqual(self.service().get(self.admin,'w','dataset')['release_id'],saved['release_id'])
        with self.assertRaises(Forbidden): self.service().save(self.viewer,'w',record('viewer'),operation_key='save')

    def test_body_cannot_overwrite_owner_or_clear_builtin_readonly(self):
        service=self.service(); prepared=service._prepare_record({**record(), 'datasetKind':'benchmark'})
        with self.control.transaction() as con: saved=service._save_tx(con,self.admin,'w',prepared,operation_key='builtin',allow_readonly=True)
        value=copy.deepcopy(saved['dataset']); value['datasetKind']='ideal_output'; value['readOnly']=False
        with self.assertRaises(Forbidden): service.save(self.admin,'w',value,operation_key='edit')
        with self.assertRaises(Forbidden): service.remove(self.admin,'w','dataset',operation_key='delete')

    def test_unpublished_trace_generation_cannot_be_edited_by_ordinary_save(self):
        service=self.service(); value={**record(), 'cases':[], 'generationSource':'trace', 'generationStatus':'generating'}
        prepared=service._prepare_record(value)
        with self.control.transaction() as con: service._save_tx(con,self.token,'w',prepared,operation_key='generation-create',allow_generated=True)
        with self.assertRaises(Conflict): service.save(self.token,'w',record(),operation_key='edit')
        value['generationStatus']='published'; value['cases']=record()['cases']; prepared=service._prepare_record(value)
        with self.control.transaction() as con: saved=service._save_tx(con,self.token,'w',prepared,operation_key='generation-complete',expected_revision=1,allow_generated=True)
        self.assertEqual(saved['dataset']['generationStatus'],'published')

    def test_generation_and_dataset_publication_rollback_together(self):
        service=self.service(); prepared=service._prepare_record(record())
        with self.assertRaises(RuntimeError), self.control.transaction() as con:
            service._save_tx(con,self.token,'w',prepared,operation_key='atomic'); raise RuntimeError('job commit failed')
        self.assertEqual(service.list(self.token,'w'),[])
        with self.control.read_transaction() as con:
            for table in ('asset_identities','asset_releases','dataset_operation_receipts','iam_resource_access'):
                self.assertEqual(con.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)

    def test_remove_restore_keeps_versions_and_fences_old_revision(self):
        service=self.service(); first=self.save(); deleted=service.remove(self.token,'w','dataset',operation_key='delete',expected_revision=1)
        self.assertEqual(deleted['revision'],'2'); self.assertEqual(service.list(self.token,'w'),[])
        with self.assertRaises(service.not_found): service.get(self.token,'w','dataset')
        restored=service.restore(self.token,'w','dataset',operation_key='restore',expected_revision=2)
        self.assertEqual(restored['revision'],'3'); self.assertEqual(restored['lifecycle_revision'],'3')
        self.assertEqual(restored['release_id'],first['release_id']); self.assertEqual(len(service.versions(self.token,'w','dataset')),1)
        with self.assertRaises(Conflict): service.save(self.token,'w',record(),operation_key='late',expected_revision=1)

    def test_explicit_delete_capability_and_live_revocation_on_receipt_retry(self):
        self.save(); credential=self.iam.issue_api_credential(self.token,'w',{'read','write'})
        with self.assertRaises(Forbidden): self.service().remove(credential,'w','dataset',operation_key='delete')
        self.iam.revoke_credential(self.token)
        from services.storage.iam import Unauthorized
        with self.assertRaises(Unauthorized): self.save()

    def test_invalid_case_and_budget_are_atomic_before_any_identity(self):
        service=self.service(); invalid=record(); invalid['cases'].append(copy.deepcopy(invalid['cases'][0]))
        with self.assertRaises(ValueError): self.save(invalid)
        invalid=record(); invalid['cases'][0]['values']['value']=float('nan')
        with self.assertRaises(ValueError): self.save(invalid)
        with patch('services.storage.datasets.MAX_DATASET_BYTES',64),self.assertRaises(service.too_large): self.save()
        self.assertEqual(service.list(self.token,'w'),[])

    def test_small_draft_and_private_case_artifacts_preserve_large_trace(self):
        value=record(); value['cases'][0]['trajectory']='完整正文🙂'*10000; saved=self.save(value)
        with self.control.read_transaction() as con:
            draft=con.execute('SELECT manifest_json FROM asset_drafts').fetchone()[0]
            self.assertLess(len(draft.encode()),4096); self.assertNotIn('完整正文',draft)
            self.assertGreater(con.execute("SELECT COUNT(*) FROM artifact_metadata WHERE namespace='dataset.gold'").fetchone()[0],0)
        self.assertEqual(self.service().get(self.token,'w','dataset')['dataset']['cases'],value['cases'])
        from services.storage.authorized import AuthorizedStorage
        with self.control.read_transaction() as con: gold=con.execute("SELECT artifact_id FROM artifact_metadata WHERE namespace='dataset.gold'").fetchone()[0]
        with self.assertRaises(Forbidden): AuthorizedStorage(self.iam,None).read_artifact(self.token,'w',gold)

    def test_listing_metadata_filters_and_light_views_do_not_invent_full_trace(self):
        value=record(); value['cases'][0]['trajectory']='long trace'; self.save(value)
        service=self.service(); rows=service.list(self.token,'w',include_metadata=True,target_skill='skill',include_trace=False)
        self.assertEqual(rows[0]['_storageEtag'],service.get(self.token,'w','dataset')['etag']); self.assertEqual(rows[0]['cases'][0]['trajectory'],'')
        self.assertEqual(service.list(self.token,'w',target_skill='missing'),[])
        self.assertNotIn('cases',service.list(self.token,'w',view='summary')[0])

    def test_immutable_releases_receipts_and_mapping_direct_sql(self):
        self.save()
        for sql in ("UPDATE dataset_compat_heads SET asset_id='different'", "DELETE FROM dataset_compat_heads", "UPDATE dataset_operation_receipts SET request_hash='bad'", "DELETE FROM dataset_operation_receipts", "DELETE FROM asset_releases"):
            with self.subTest(sql=sql),self.assertRaises(Conflict),self.control.transaction() as con: con.execute(sql)

    def test_same_request_racing_replay_commits_only_one_version(self):
        service=self.service(); prepared=service._prepare_record(record())
        with self.control.transaction() as con: first=service._save_tx(con,self.token,'w',prepared,operation_key='same')
        with self.control.transaction() as con: second=service._save_tx(con,self.token,'w',prepared,operation_key='same',expected_revision=0)
        self.assertEqual(first,second); self.assertEqual(len(service.versions(self.token,'w','dataset')),1)

    def test_minimal_record_receipt_and_ignored_client_metadata_are_stable(self):
        service=self.service(); value={'id':'minimal','name':'Minimal'}
        first=service.save(self.token,'w',value,operation_key='minimal')
        self.assertEqual(service.save(self.token,'w',{**value,'user':'bob','_storageEtag':'old'},operation_key='minimal'),first)

    def test_admin_edits_keep_resource_owner_and_save_after_restore_uses_current_draft(self):
        service=self.service(); self.save(); service.remove(self.token,'w','dataset',operation_key='delete')
        service.restore(self.token,'w','dataset',operation_key='restore')
        updated=service.save(self.admin,'w',record(),operation_key='admin',expected_revision=3)
        self.assertEqual(updated['dataset']['user'],'alice'); self.assertEqual(updated['revision'],'4')

    def test_unversioned_save_still_rejects_changes_during_preparation(self):
        service=self.service(); self.save(); original=service._prepare_record; entered=False
        def racing(value,**kwargs):
            nonlocal entered
            prepared=original(value,**kwargs)
            if not entered:
                entered=True; service.save(self.token,'w',{**record(),'name':'winner'},operation_key='winner',expected_revision=1)
            return prepared
        with patch.object(service,'_prepare_record',side_effect=racing), self.assertRaises(Conflict):
            service.save(self.token,'w',record(),operation_key='loser')
        self.assertEqual(service.get(self.token,'w','dataset')['dataset']['name'],'winner')

    def test_summary_reads_only_members_metadata_not_private_case_bodies(self):
        service=self.service(); self.save(); original=service._load
        with self.control.read_transaction() as con: root=con.execute('SELECT manifest_hash FROM dataset_compat_heads').fetchone()[0]
        def guarded(digest,*args,**kwargs):
            self.assertEqual(digest,root,'summary must not read any Case body')
            return original(digest,*args,**kwargs)
        with patch.object(service,'_load',side_effect=guarded): self.assertEqual(service.list(self.token,'w',view='summary')[0]['caseCount'],1)

    def test_derived_root_cause_cache_keeps_business_time_and_immutable_version(self):
        service=self.service(); first=self.save(); self.now+=1000
        self.assertTrue(service.cache_root_causes(self.token,'w','dataset','case','答案',[{'text':'grounded'}],expected_revision=1,root_cause_meta={'source':'fixture'}))
        current=service.get(self.token,'w','dataset'); old=service.get(self.token,'w','dataset',version=first['release_id'])
        self.assertEqual(current['dataset']['cases'][0]['rootCauses'],[{'text':'grounded'}]); self.assertNotIn('rootCauses',old['dataset']['cases'][0])
        self.assertEqual(current['revision'],first['revision']); self.assertEqual(current['dataset']['updatedAt'],first['dataset']['updatedAt']); self.assertEqual(len(service.versions(self.token,'w','dataset')),1)
        self.assertFalse(service.cache_root_causes(self.token,'w','dataset','case','different',[],expected_revision=1))

    def test_direct_sql_cannot_bind_draft_of_another_asset(self):
        self.save(); self.save(record('second'),key='second')
        with self.control.read_transaction() as con:
            first=dict(con.execute('SELECT * FROM dataset_compat_heads WHERE dataset_id=?',('dataset',)).fetchone()); second=dict(con.execute('SELECT * FROM dataset_compat_heads WHERE dataset_id=?',('second',)).fetchone())
        with self.assertRaises(Conflict),self.control.transaction() as con:
            con.execute('UPDATE dataset_compat_heads SET draft_id=?,revision=revision+1 WHERE dataset_id=?',(second['draft_id'],'dataset'))

    def test_noop_backflow_receipt_keeps_versions_and_business_timestamp(self):
        service=self.service(); first=self.save(); self.now+=1000
        result=service.record_operation(self.token,'w','dataset',operation_key='duplicate-backflow',operation_kind='backflow',operation_request={'tasks':['task']},operation_result={'added':0,'skippedDuplicates':1},expected_revision=1)
        self.assertEqual(result['revision'],first['revision']); self.assertEqual(result['dataset']['updatedAt'],first['dataset']['updatedAt'])
        self.assertEqual(len(service.versions(self.token,'w','dataset')),1)
        self.assertEqual(service.lookup_operation(self.token,'w','backflow','duplicate-backflow',{'tasks':['task']}),result)

    def test_projection_retries_immutable_versions_after_partial_sink_failure(self):
        service=self.service(); first=self.save(); calls=[]; fail=True
        class Facts:
            def _insert(inner,table,rows):
                nonlocal fail
                calls.append((table,copy.deepcopy(rows)))
                if table=='dataset_release_members' and fail: fail=False; raise OSError('network dropped')
        sink=Facts(); self.assertTrue(service.project_once(sink,'worker'))
        self.assertEqual(service.projection_status(self.token,'w','dataset')['state'],'pending')
        self.now+=100000; self.assertTrue(service.project_once(sink,'restarted'))
        self.assertEqual(service.projection_status(self.token,'w','dataset')['state'],'indexed')
        self.assertEqual(calls[0],calls[2]); self.assertEqual(calls[1],calls[3]); self.assertEqual(calls[3][1][0]['dataset_release_id'],first['release_id'])
        self.assertEqual(service.get(self.token,'w','dataset')['dataset']['cases'],record()['cases'])

    def test_deleted_route_fences_pending_projection_without_resurrecting_facts(self):
        service=self.service(); self.save(); service.remove(self.token,'w','dataset',operation_key='delete')
        class Facts:
            def _insert(inner,*args): self.fail('deleted Dataset must not project stale work')
        self.assertTrue(service.project_once(Facts(),'worker'))
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='dataset.release.published.v1' ORDER BY created_at_ms,event_id LIMIT 1").fetchone()[0],'dead')

    def test_delete_only_credential_can_delete_and_write_only_cannot_replay_delete(self):
        service=self.service(); self.save(); delete=self.iam.issue_api_credential(self.token,'w',{'read','delete'})
        removed=service.remove(delete,'w','dataset',operation_key='delete'); self.assertTrue(removed['removed'])
        write=self.iam.issue_api_credential(self.token,'w',{'read','write'})
        with self.assertRaises(Forbidden): service.remove(write,'w','dataset',operation_key='delete')

    def test_restore_and_save_receipts_cannot_leak_gold_to_credentials_without_read(self):
        service=self.service(); self.save(); service.remove(self.token,'w','dataset',operation_key='delete'); service.restore(self.token,'w','dataset',operation_key='restore')
        delete=self.iam.issue_api_credential(self.token,'w',{'delete'}); write=self.iam.issue_api_credential(self.token,'w',{'write'})
        with self.assertRaises(Forbidden): service.restore(delete,'w','dataset',operation_key='restore')
        with self.assertRaises(Forbidden): service.save(write,'w',record(),operation_key='save')
        with patch.object(service,'_envelope',side_effect=AssertionError('read gate must precede payload IO')),self.assertRaises(Forbidden):
            service.record_operation(write,'w','dataset',operation_key='noop',operation_kind='backflow',operation_request={},operation_result={},expected_revision=3)

    def test_generic_delete_receipt_lookup_uses_delete_capability_without_write(self):
        service=self.service(); self.save(); request={'id':'dataset'}
        expected=service.remove(self.token,'w','dataset',operation_key='delete',operation_request=request)
        credential=self.iam.issue_api_credential(self.token,'w',{'read','delete'})
        self.assertEqual(service.lookup_operation(credential,'w','delete','delete',request),expected)

    def test_catalog_columns_and_dialect_table_sets_are_coherent(self):
        schema=Path(__file__).resolve().parents[1]/'schema'; catalog=json.loads((schema/'dataset-catalog.json').read_text())
        with self.control.read_transaction() as con:
            for table in catalog['tables']:
                # Portable SELECT proves all named columns exist on actual transaction backends.
                con.execute('SELECT '+','.join(column['name'] for column in table['columns'])+' FROM '+table['name']+' WHERE 1=0')
        import re
        expected={table['name'] for table in catalog['tables']}
        for backend in ('sqlite','postgresql','opengauss'):
            self.assertEqual(set(re.findall(r'CREATE TABLE (\w+)',(schema/backend/'008_dataset_assets.sql').read_text())),expected)

    def test_delete_restore_does_not_make_an_old_projection_worker_valid_again(self):
        service=self.service(); self.save(); service.remove(self.token,'w','dataset',operation_key='delete')
        service.restore(self.token,'w','dataset',operation_key='restore')
        calls=[]
        class Facts:
            def _insert(inner,*args): calls.append(args)
        self.assertTrue(service.project_once(Facts(),'worker'))
        self.assertEqual(calls,[])
        with self.control.read_transaction() as con:self.assertEqual(con.execute("SELECT state FROM outbox_events WHERE event_type='dataset.release.published.v1' ORDER BY created_at_ms,event_id LIMIT 1").fetchone()[0],'dead')

    def test_restore_enqueues_new_lifecycle_projection_without_reviving_old_worker(self):
        service=self.service(); self.save(); service.remove(self.token,'w','dataset',operation_key='delete'); service.restore(self.token,'w','dataset',operation_key='restore')
        calls=[]
        class Facts:
            def _insert(inner,*args): calls.append(args)
        self.assertTrue(service.project_once(Facts(),'old')); self.assertEqual(calls,[])
        self.assertEqual(service.projection_status(self.token,'w','dataset')['state'],'pending')
        self.assertTrue(service.project_once(Facts(),'restored')); self.assertEqual(len(calls),2)
        self.assertEqual(service.projection_status(self.token,'w','dataset')['state'],'indexed')

    def test_version_summary_is_bounded_and_has_version_specific_etag(self):
        service=self.service(); first=self.save(); original=service._load
        with self.control.read_transaction() as con: root=con.execute('SELECT manifest_hash FROM dataset_compat_heads').fetchone()[0]
        def only_metadata(digest,*args,**kwargs):
            self.assertEqual(digest,root); return original(digest,*args,**kwargs)
        with patch.object(service,'_load',side_effect=only_metadata): versions=service.versions(self.token,'w','dataset',view='summary')
        self.assertEqual(versions[0]['dataset']['caseCount'],1); self.assertNotEqual(versions[0]['etag'],first['etag'])
        with patch('services.storage.datasets.MAX_VERSIONS',1):
            self.save(record(),key='second')
            with self.assertRaises(service.too_large): service.versions(self.token,'w','dataset',view='summary')

    def test_list_and_version_aggregate_byte_budgets_stop_before_loading_remaining_bodies(self):
        service=self.service()
        for index in range(5): self.save(record('d'+str(index)),key='d'+str(index))
        sample=service.get(self.token,'w','d0')['dataset']; size=len(json.dumps(sample,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8'))
        with patch('services.storage.datasets.MAX_DATASET_BYTES',size+10),patch.object(service,'get',wraps=service.get) as reader,self.assertRaises(service.too_large):
            service.list(self.token,'w')
        self.assertEqual(reader.call_count,2,'list must stop after the first item that exceeds the cumulative budget')
        for index in range(4): self.save(record('d0'),key='version'+str(index))
        for view in ('full','summary'):
            sample=service.get(self.token,'w','d0',version='1',_view=view); size=len(json.dumps(sample,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8'))
            with patch('services.storage.datasets.MAX_DATASET_BYTES',size+10),patch.object(service,'get',wraps=service.get) as reader,self.assertRaises(service.too_large):
                service.versions(self.token,'w','d0',view=view)
            self.assertEqual(reader.call_count,2,'version collection must not load all remaining immutable versions')

    def test_dataset_count_budget_rejects_before_loading_any_body(self):
        service=self.service(); self.save(); self.save(record('second'),key='second')
        with patch('services.storage.datasets.MAX_DATASETS',1),patch.object(service,'get',wraps=service.get) as reader,self.assertRaises(service.too_large):
            service.list(self.token,'w')
        self.assertEqual(reader.call_count,0)

    def test_dataset_count_budget_only_counts_resources_visible_to_actual_actor(self):
        service=self.service(); self.save()
        for index in range(2): service.save(self.bob,'w',record('bob'+str(index)),operation_key='bob'+str(index))
        with patch('services.storage.datasets.MAX_DATASETS',1): self.assertEqual([row['id'] for row in service.list(self.token,'w')],['dataset'])

    def test_corrupt_private_case_never_gets_marked_indexed(self):
        service=self.service(); self.save()
        with self.control.read_transaction() as con: ref=con.execute("SELECT object_ref FROM artifact_metadata WHERE namespace='dataset.gold'").fetchone()[0]
        Path(ref).write_text('corrupt')
        class Facts:
            def _insert(inner,*args): self.fail('corrupt source must not be projected')
        self.assertTrue(service.project_once(Facts(),'worker'))
        self.assertEqual(service.projection_status(self.token,'w','dataset')['state'],'failed')

    def test_custom_gold_aliases_and_opaque_case_extensions_are_private_but_authoring_is_lossless(self):
        service=self.service(); value=record(); value['cases'][0]['values'].update(custom_answer='private-gold',available_tools=['read'],input='real user input',custom_false=False,custom_zero=0)
        value['cases'][0]['opaque']={'gold_alias':'private-gold'}; value['cases'][0]['trajectory']='private trajectory'
        self.save(value)
        with self.control.read_transaction() as con:
            root=con.execute('SELECT manifest_hash,manifest_ref FROM dataset_compat_heads').fetchone()
        manifest=service._load(root[0],root[1]); member=manifest['members'][0]
        public=service._load(member['public']['hash'],member['public']['ref'])
        self.assertNotIn('private-gold',json.dumps(public)); self.assertNotIn('trajectory',public); self.assertNotIn('opaque',public)
        self.assertEqual(public['values'],{'available_tools':['read'],'input':'real user input'})
        self.assertEqual(service.get(self.token,'w','dataset')['dataset']['cases'],value['cases'])

    def test_case_and_items_views_never_read_unrelated_or_full_large_trace_artifacts(self):
        service=self.service(); value=record(); value['cases'].append({**copy.deepcopy(value['cases'][0]),'id':'large','trajectory':'large-secret-'*20000}); self.save(value)
        with self.control.read_transaction() as con: row=con.execute('SELECT manifest_hash,manifest_ref FROM dataset_compat_heads').fetchone()
        manifest=service._load(row[0],row[1]); forbidden={manifest['members'][1]['public']['hash'],manifest['members'][1]['private']['hash']}; original=service._load
        def guarded(digest,*args,**kwargs):
            self.assertNotIn(digest,forbidden,'unrelated large Case bodies must stay private and unread')
            return original(digest,*args,**kwargs)
        with patch.object(service,'_load',side_effect=guarded):
            selected=service.get(self.token,'w','dataset',_view='case',_case_id='case'); self.assertEqual(len(selected['dataset']['cases']),1)
            items=service.get(self.token,'w','dataset',_view='items'); self.assertLess(len(items['dataset']['cases'][1]['trajectory']),700)
        with self.assertRaises(service.not_found): service.get(self.token,'w','dataset',_view='case',_case_id='missing')

    def test_new_case_source_requires_actual_trace_access_but_frozen_copy_survives_source_delete(self):
        from services.storage.authorized import AuthorizedStorage
        source=AuthorizedStorage(self.iam,None); source.create_trace(self.token,'w','source','2026-11-12',source_namespace='fixture',native_trace_id='native')
        from services.storage.trace_metadata import TraceMetadata
        metadata=TraceMetadata(self.control); metadata.register_aliases_for_provisioning('w','source',task_id='source-task')
        value=record(); value['cases'][0]['traceSource']={'taskId':'source-task','capturedAt':'2026-11-12T00:00:00Z'}
        service=self.service(); service.save(self.token,'w',value,operation_key='source')
        with self.control.read_transaction() as con: initial=con.execute('SELECT manifest_hash,manifest_ref FROM dataset_compat_heads').fetchone()
        proof=service._load(initial[0],initial[1])['source_provenance']
        metadata.delete(self.token,'w','source')
        value['name']='still editable'; service.save(self.token,'w',value,operation_key='existing-copy',expected_revision=1)
        with self.control.read_transaction() as con: current=con.execute('SELECT manifest_hash,manifest_ref FROM dataset_compat_heads').fetchone()
        self.assertEqual(service._load(current[0],current[1])['source_provenance'],proof,'unchanged copied sources retain their original frozen provenance')
        value['cases'][0]['id']='new-copy'
        with self.assertRaises((Forbidden,Conflict)): service.save(self.token,'w',value,operation_key='new-copy',expected_revision=2)

    def test_new_foreign_source_claim_and_source_change_during_prepare_are_rejected_atomically(self):
        from services.storage.authorized import AuthorizedStorage
        from services.storage.trace_metadata import TraceMetadata
        source=AuthorizedStorage(self.iam,None); source.create_trace(self.bob,'w','foreign','2026-11-12',source_namespace='fixture',native_trace_id='foreign')
        value=record(); value['cases'][0]['traceSource']={'taskId':'foreign'}
        with self.assertRaises(Forbidden): self.save(value)
        source.create_trace(self.token,'w','mine','2026-11-12',source_namespace='fixture',native_trace_id='mine')
        value['cases'][0]['traceSource']={'taskId':'mine'}; service=self.service(); original=service._prepare_record
        def retiring(*args,**kwargs):
            prepared=original(*args,**kwargs); TraceMetadata(self.control).delete(self.token,'w','mine'); return prepared
        with patch.object(service,'_prepare_record',side_effect=retiring),self.assertRaises((Forbidden,Conflict)):
            service.save(self.token,'w',value,operation_key='stale-source')
        self.assertEqual(service.list(self.token,'w'),[])

    @unittest.skipUnless(os.environ.get('AGENT_INSIGHT_DATASETS_CH_URL'),'optional isolated real ClickHouse contract')
    def test_real_clickhouse_projection_replays_partial_commit_with_fixed_members(self):
        import uuid
        from services.storage.clickhouse import ClickHouseStore
        database='dataset_contract_'+uuid.uuid4().hex
        facts=ClickHouseStore(os.environ['AGENT_INSIGHT_DATASETS_CH_URL'],database=database)
        facts.initialize_new_database(); self.addCleanup(lambda:facts._request('DROP DATABASE '+database,database='default'))
        service=self.service(); value=record(); value['cases'].append({**copy.deepcopy(value['cases'][0]),'id':'case2'})
        saved=self.save(value); original=facts._insert; lost=False
        def commit_drop(table,rows):
            nonlocal lost
            original(table,rows)
            if table=='dataset_release_members' and not lost: lost=True; raise OSError('response lost after real CH commit')
        with patch.object(facts,'_insert',side_effect=commit_drop): self.assertTrue(service.project_once(facts,'first'))
        self.now+=100000; self.assertTrue(service.project_once(facts,'retry'))
        self.assertEqual(service.projection_status(self.token,'w','dataset')['state'],'indexed')
        rows=[json.loads(line) for line in facts._request('SELECT case_key,sample_revision_id,content_hash FROM dataset_release_members FINAL ORDER BY ordinal FORMAT JSONEachRow').splitlines()]
        self.assertEqual([row['case_key'] for row in rows],['case','case2']); self.assertEqual(len({row['sample_revision_id'] for row in rows}),2)
        self.assertTrue(all(len(row['content_hash'])==64 for row in rows))
        self.assertEqual(service.get(self.token,'w','dataset',version=saved['release_id'])['dataset']['cases'],value['cases'])


if __name__=='__main__': unittest.main()
