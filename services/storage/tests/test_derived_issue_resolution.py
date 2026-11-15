import json
import sqlite3
import unittest
import hashlib
from pathlib import Path
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_experiments as fixture


class DerivedIssueResolutionTests(unittest.TestCase):
    make_control=fixture.ExperimentTests.make_control
    setUp=fixture.ExperimentTests.setUp

    def prepare(self,shared_source=False):
        from services.storage.tests.test_trace_transfer import MemoryFacts
        from services.storage.tests.test_observations import packet
        from services.storage.observations import ObservationIngest
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        from services.storage.experiments import ExperimentStore
        facts=MemoryFacts();ingest=ObservationIngest(self.control,facts);accepted=ingest.accept(self.bob if shared_source else self.token,'w',packet());ingest.work_once('worker')
        self.trace_id=accepted['trace_ids'][0]
        if shared_source:self.iam.share_resource(self.bob,'w','trace',self.trace_id,'alice')
        evidence=TraceEvidence(TraceQueries(self.control,facts,cursor_secret=b'derived-issue-resolution-secret'),AuthorizedStorage(self.iam,facts))
        self.service=ExperimentStore(self.control,evidence=evidence,frozen_assets_verifier=lambda *_:True)
        value=fixture.experiment();value['cases'][0]['taskId']='a'*32
        self.call('create',experiment=value,operation_key='create')
        self.call('start',experiment_id='exp',config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]}},frozen_evaluators={'judge':{'id':'judge'}},operation_key='start')
        self.handle=self.call('claim',experiment_id='exp',worker_id='worker')
        evaluation={'id':'evaluation','type':'dynamic','skillId':'skill','version':1,'executionId':'a'*32,'status':'ok'}
        issue={'id':'issue','evaluationId':'evaluation','skillId':'skill','version':1,'source':'trajectory','ruleId':'rule','summary':'private issue'}
        self.call('complete',**fixture.ExperimentTests.handle(self.handle),result={'score':20,'evidence':{'json':{'directTrajectoryDerived':{'evaluations':[evaluation],'skillIssues':[issue]}}}},operation_key='complete')

    def call(self,action,**body):return self.service.dispatch(action,self.token,'w',body)
    def resolve(self,**overrides):return self.call('derived_issue_resolve',**({'issue_ids':['issue'],'resolved_run_id':'optimization-run','operation_key':'resolve','operation_request':{'issue_ids':['issue'],'resolved_run_id':'optimization-run'}}|overrides))

    def test_resolution_projects_without_changing_machine_evidence_and_exact_retry(self):
        self.prepare()
        with self.control.read_transaction() as con:
            original=dict(con.execute("SELECT * FROM experiment_annotations WHERE annotation_id='issue'").fetchone());machine=dict(con.execute('SELECT * FROM result_receipts').fetchone())
        first=self.resolve();self.assertEqual(first['resolved_ids'],['issue']);self.assertEqual(first['newly_resolved'],1);self.assertEqual(self.resolve(),first)
        issue=self.call('derived_lookup',kind='issue',id='issue');self.assertEqual(issue['resolvedRunId'],'optimization-run');self.assertIsNotNone(issue['resolvedAt'])
        self.assertEqual(self.call('derived_detail',id='evaluation')['issues'][0]['resolvedAt'],issue['resolvedAt'])
        with self.control.read_transaction() as con:
            self.assertEqual(dict(con.execute("SELECT * FROM experiment_annotations WHERE annotation_id='issue'").fetchone()),original)
            self.assertEqual(dict(con.execute('SELECT * FROM result_receipts').fetchone()),machine)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_derived_issue_annotations').fetchone()[0],1)
        with self.assertRaises(Conflict):self.resolve(operation_request={'changed':True})

    def test_manual_resolution_without_a_thread_preserves_public_null_and_immutable_facts(self):
        self.prepare()
        with self.control.read_transaction() as con:machine=dict(con.execute('SELECT * FROM result_receipts').fetchone())
        request={'issue_ids':['issue'],'resolved_run_id':None}
        first=self.resolve(resolved_run_id=None,operation_request=request)
        self.assertIsNone(first['resolved_run_id']);self.assertEqual(first['newly_resolved'],1)
        self.assertEqual(self.resolve(resolved_run_id=None,operation_request=request),first)
        issue=self.call('derived_lookup',kind='issue',id='issue')
        self.assertIsNotNone(issue['resolvedAt']);self.assertIsNone(issue['resolvedRunId'])
        with self.control.read_transaction() as con:
            self.assertEqual(dict(con.execute('SELECT * FROM result_receipts').fetchone()),machine)
            row=con.execute('SELECT resolved_run_id FROM experiment_derived_issue_annotations').fetchone()
            self.assertTrue(row[0].startswith('resolution-operation:'))

    def test_optional_lookup_distinguishes_missing_from_a_known_stale_source(self):
        self.prepare()
        self.assertEqual(self.call('derived_lookup',kind='issue',id='absent',allow_missing=True),{'found':False,'value':None})
        self.assertEqual(self.call('derived_lookup',kind='issue',id='issue',allow_missing=True)['value']['id'],'issue')
        from services.storage.trace_metadata import TraceMetadata
        TraceMetadata(self.control).delete(self.token,'w',self.trace_id)
        with self.assertRaises(Conflict):self.call('derived_lookup',kind='issue',id='issue',allow_missing=True)

    def test_static_resolution_bridge_requires_current_write_capability(self):
        self.prepare()
        self.assertIsInstance(self.call('derived_resolution_scope')['fingerprint'],str)
        read_only=self.iam.issue_api_credential(self.token,'w',['read'])
        with self.assertRaises(Forbidden):self.service.dispatch('derived_resolution_scope',read_only,'w',{})

    def test_nullable_resolution_projects_all_experiments_from_one_exact_receipt(self):
        self.prepare()
        value=fixture.experiment();value['id']='second-exp';value['cases'][0].update(id='second-case',taskId='a'*32)
        self.call('create',experiment=value,operation_key='second-create')
        self.call('start',experiment_id='second-exp',config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]}},frozen_evaluators={'judge':{'id':'judge'}},operation_key='second-start')
        handle=self.call('claim',experiment_id='second-exp',worker_id='second-worker')
        evaluation={'id':'second-evaluation','type':'dynamic','skillId':'skill','version':1,'executionId':'a'*32,'status':'ok'}
        issue={'id':'second-issue','evaluationId':'second-evaluation','skillId':'skill','version':1,'source':'trajectory','ruleId':'rule'}
        self.call('complete',**(fixture.ExperimentTests.handle(handle)|{'experiment_id':'second-exp'}),result={'score':40,'evidence':{'json':{'directTrajectoryDerived':{'evaluations':[evaluation],'skillIssues':[issue]}}}},operation_key='second-complete')
        request={'issue_ids':['issue','second-issue'],'resolved_run_id':None}
        self.resolve(**request,operation_request=request)
        for identity in request['issue_ids']:
            dto=self.call('derived_lookup',kind='issue',id=identity)
            self.assertIsNone(dto['resolvedRunId']);self.assertIsNotNone(dto['resolvedAt'])
        original=self.service._load
        def damaged(digest,ref,*args):
            packet=original(digest,ref,*args)
            if packet.get('resolved_ids')==request['issue_ids']:return packet|{'resolved_ids':['different']}
            return packet
        from services.storage.experiments import ExperimentUnavailable
        with patch.object(self.service,'_load',damaged),self.assertRaises(ExperimentUnavailable):self.call('derived_lookup',kind='issue',id='second-issue')

    def test_unknown_unattested_and_other_owner_cannot_resolve_or_fake_success(self):
        self.prepare()
        with self.assertRaises(Forbidden):self.service.dispatch('derived_issue_resolve',self.admin,'w',{'issue_ids':['issue'],'resolved_run_id':'run','operation_key':'admin'})
        self.service.frozen_assets_verifier=None
        with self.assertRaises(Forbidden):self.resolve()
        self.service.frozen_assets_verifier=lambda *_:True
        from services.storage.experiments import ExperimentNotFound
        with self.assertRaises(ExperimentNotFound):self.resolve(issue_ids=['unknown'],operation_request={'issue_ids':['unknown']})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_derived_issue_annotations').fetchone()[0],0)

    def test_new_resolution_rejects_superseded_selection_but_exact_history_retry_survives(self):
        self.prepare();original=self.resolve()
        self.call('retry',experiment_id='exp',result_id=self.handle['result_id'],operation_key='retry')
        self.assertEqual(self.resolve(),original)
        with self.assertRaises(Conflict):self.resolve(operation_key='new-operation')

    def test_batch_is_atomic_and_source_deleted_blocks_receipt_replay(self):
        self.prepare()
        from services.storage.experiments import ExperimentNotFound
        with self.assertRaises(ExperimentNotFound):self.resolve(issue_ids=['issue','missing'],operation_request={'ids':['issue','missing']})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_derived_issue_annotations').fetchone()[0],0)
        self.resolve()
        from services.storage.trace_metadata import TraceMetadata
        metadata=TraceMetadata(self.control);trace=metadata.resolve(self.token,'w','a'*32,'task')['trace_id'];metadata.delete(self.token,'w',trace)
        with self.assertRaises(Conflict):self.resolve()

    def test_annotation_table_forbids_update_and_delete(self):
        self.prepare();self.resolve()
        for statement in ('UPDATE experiment_derived_issue_annotations SET resolved_run_id=\'changed\'','DELETE FROM experiment_derived_issue_annotations'):
            with self.subTest(statement=statement),self.assertRaises(Exception),self.control.transaction() as con:con.execute(statement)

    def test_resolve_keeps_first_annotation_and_does_not_mark_new_generation_issue(self):
        self.prepare();self.resolve();other=self.resolve(operation_key='second',resolved_run_id='second-run',operation_request={'issue_ids':['issue'],'resolved_run_id':'second-run'})
        self.assertEqual(other['newly_resolved'],0);self.assertEqual(self.call('derived_lookup',kind='issue',id='issue')['resolvedRunId'],'optimization-run')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_derived_issue_annotations').fetchone()[0],1)

    def test_live_shared_source_revocation_blocks_resolution_and_committed_replay(self):
        self.prepare(shared_source=True);self.resolve();self.iam.unshare_resource(self.bob,'w','trace',self.trace_id,'alice')
        with self.assertRaises(Forbidden):self.resolve()
        with self.assertRaises(Forbidden):self.resolve(operation_key='other')

    def test_owned_issue_pages_filter_before_limit_for_admins_using_the_same_shared_skill(self):
        self.prepare();value=fixture.experiment();value.update(id='admin-exp');value['cases'][0].update(id='admin-case',taskId='a'*32)
        def admin(action,**body):return self.service.dispatch(action,self.admin,'w',body)
        admin('create',experiment=value,operation_key='admin-create')
        admin('start',experiment_id='admin-exp',config={'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]}},frozen_evaluators={'judge':{'id':'judge'}},operation_key='admin-start')
        handle=admin('claim',experiment_id='admin-exp',worker_id='admin-worker')
        evaluation={'id':'admin-evaluation','type':'dynamic','skillId':'skill','version':1,'executionId':'a'*32,'status':'ok'}
        issues=[{'id':'z-admin-issue-'+str(index),'evaluationId':'admin-evaluation','skillId':'skill','version':1,'source':'dynamic','user':'forged-legacy-alias'} for index in (1,2)]
        admin('complete',experiment_id='admin-exp',**{key:handle[key] for key in ('attempt_id','fence','lease_owner')},result={'score':50,'evidence':{'json':{'directTrajectoryDerived':{'evaluations':[evaluation],'skillIssues':issues}}}},operation_key='admin-complete')
        first=admin('derived_list',kind='issue',skill_id='skill',owned_only=True,limit=1);self.assertEqual([row['id'] for row in first],['z-admin-issue-1']);self.assertNotIn('gold_redacted',first[0])
        second=admin('derived_list',kind='issue',skill_id='skill',owned_only=True,limit=1,after_id=first[0]['id']);self.assertEqual([row['id'] for row in second],['z-admin-issue-2'])
        self.assertEqual(admin('derived_list',kind='issue',skill_id='skill',owned_only=True,limit=1,after_id=second[0]['id']),[])
        self.assertTrue(admin('derived_lookup',kind='issue',id='issue')['gold_redacted'])


class DerivedIssueMigrationPreservationTests(unittest.TestCase):
    make_control=DerivedIssueResolutionTests.make_control
    prepare=DerivedIssueResolutionTests.prepare
    call=DerivedIssueResolutionTests.call
    def setUp(self):
        from services.storage import migrations
        original=migrations.load_migrations
        with patch.object(migrations,'load_migrations',side_effect=lambda backend:original(backend)[:13]):fixture.ExperimentTests.setUp(self)

    def test_013_to_014_preserves_all_old_rows_private_artifacts_and_prefix_checksums(self):
        from services.storage import migrations
        original=migrations.load_migrations;root=Path(migrations.__file__).parent/'schema';backend=getattr(self.control,'backend','sqlite')
        before_prefix=[(m.version,m.checksum) for m in original(backend)[:13]]
        catalogs=('core','iam','project','ingest','metadata','diagnosis','report','dataset','dataset-generation','experiment','diagnosis-run','benchmark')
        names=sorted({table['name'] for name in catalogs for table in json.loads((root/(name+'-catalog.json')).read_text())['tables']})
        def snapshot():
            with self.control.read_transaction() as con:
                return {name:sorted(json.dumps(list(row),ensure_ascii=False,sort_keys=True,default=str) for row in con.execute('SELECT * FROM '+name+(' WHERE version<=13' if name=='schema_meta' else '')).fetchall()) for name in names}
        with patch.object(migrations,'load_migrations',side_effect=lambda which:original(which)[:13]):
            self.prepare();before=snapshot()
        files={path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in self.control.artifact_directory.iterdir()}
        if backend=='sqlite':
            backup=Path(self.tmp.name)/'before014.db';self.assertEqual(self.control.migrate(backup_path=backup)['current_version'],14);self.assertTrue(backup.is_file())
        else:
            with self.control.transaction() as con:migrations.apply(con,backend,clock=self.control.clock,applied=13)
        self.assertEqual(snapshot(),before);self.assertEqual([(m.version,m.checksum) for m in original(backend)[:13]],before_prefix)
        self.assertEqual(files,{path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in self.control.artifact_directory.iterdir()})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM experiment_derived_issue_annotations').fetchone()[0],0)


if __name__=='__main__':unittest.main()
