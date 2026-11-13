import concurrent.futures
import importlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from services.storage.control import Conflict, StorageError
from services.storage.iam import Forbidden, Unauthorized
from services.storage.tests import test_trace_metadata as metadata_fixture


class DiagnosisTests(unittest.TestCase):
    make_control=metadata_fixture.TraceMetadataTests.make_control
    rows=metadata_fixture.TraceMetadataTests.rows

    def setUp(self):
        metadata_fixture.TraceMetadataTests.setUp(self)
        self.meta.register_aliases_for_provisioning('w','trace',task_id='task',execution_id='execution')
        self.api=importlib.import_module('services.storage.diagnosis').TraceDiagnosis(self.control)

    def begin(self,key='request',token=None,ref='task',**changes):
        options=dict(request_key=key,message='完整问题🙂',evidence_hash='a'*64,lease_owner='worker',model_key='model-v1')
        options.update(changes)
        return self.api.begin_turn(token or self.tokens['alice'],'w',ref,**options)

    def handle(self,result):
        turn=result['turn']
        return dict(request_key=turn['request_key'],lease_owner=turn['lease_owner'],turn_fence=turn['fence'])

    def finish(self,result,**changes):
        options=dict(self.handle(result),expected_revision=result['turn']['revision'],content='完整回答🙂',opencode_session_id='upstream-1')
        options.update(changes)
        return self.api.finish_turn(self.tokens['alice'],'w',result['session']['id'],**options)

    def test_empty_session_is_authorized_and_aliases_share_one_identity(self):
        self.assertEqual(self.api.get_session(self.tokens['alice'],'w','task'),{'session':None,'messages':[]})
        first=self.api.ensure_session(self.tokens['alice'],'w','task')
        for ref in ('execution','trace'):
            self.assertEqual(self.api.ensure_session(self.tokens['alice'],'w',ref)['session']['id'],first['session']['id'])
        self.assertEqual(first['session']['executionId'],'execution')
        self.assertEqual(len(self.rows('trace_diagnosis_sessions')),1)

    def test_concurrent_initial_creation_has_one_session(self):
        def create(_):return self.api.ensure_session(self.tokens['alice'],'w','task')['session']['id']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:ids=list(pool.map(create,range(2)))
        self.assertEqual(ids[0],ids[1]);self.assertEqual(len(self.rows('trace_diagnosis_sessions')),1)

    def test_begin_allocates_stable_pair_with_full_user_content_and_history(self):
        first=self.begin();self.assertFalse(first['duplicate']);self.assertTrue(first['is_first_user_message'])
        self.assertEqual(first['messages'],[]);self.assertEqual(first['user_message']['seq'],1)
        self.assertEqual(first['assistant_message']['seq'],2);self.assertEqual(first['user_message']['content'],'完整问题🙂')
        again=self.begin();self.assertTrue(again['duplicate']);self.assertEqual(again['turn'],first['turn'])
        self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)
        self.finish(first);second=self.begin('second')
        self.assertEqual(second['user_message']['seq'],3);self.assertEqual(len(second['messages']),2)
        self.assertFalse(second['is_first_user_message'])

    def test_same_key_changes_to_any_frozen_input_conflict(self):
        self.begin()
        for changes in ({'message':'changed'},{'evidence_hash':'b'*64},{'model_key':'another'},{'opencode_session_id':None},{'context_hash':'b'*64}):
            with self.subTest(changes=changes),self.assertRaises(Conflict):self.begin(**changes)
        self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)

    def test_parallel_distinct_turns_allow_only_one_claim(self):
        def claim(key):
            try:return self.begin(key)['turn']['request_key']
            except Conflict:return 'busy'
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(claim,['a','b']))
        self.assertEqual(results.count('busy'),1);self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)

    def test_checkpoint_fulltext_cas_and_exact_retry(self):
        first=self.begin();sid=first['session']['id'];handle=self.handle(first)
        update=self.api.checkpoint(self.tokens['alice'],'w',sid,**handle,expected_revision=1,content='第一版')
        self.assertEqual(update['turn']['revision'],2)
        retry=self.api.checkpoint(self.tokens['alice'],'w',sid,**handle,expected_revision=1,content='第一版')
        self.assertEqual(retry['turn']['revision'],2)
        with self.assertRaises(Conflict):self.api.checkpoint(self.tokens['alice'],'w',sid,**handle,expected_revision=1,content='迟到覆盖')
        revised=self.api.checkpoint(self.tokens['alice'],'w',sid,**handle,expected_revision=2,content='修正完整正文')
        self.assertEqual(revised['assistant_message']['content'],'修正完整正文')
        self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)

    def test_renew_keeps_message_revision_and_never_shortens_on_clock_regression(self):
        self.now+=10000
        first=self.begin();self.now+=1000
        renewed=self.api.renew(self.tokens['alice'],'w',first['session']['id'],**self.handle(first))
        self.assertEqual(renewed['turn']['revision'],1)
        self.now-=5000
        again=self.api.renew(self.tokens['alice'],'w',first['session']['id'],**self.handle(first))
        self.assertGreaterEqual(again['turn']['lease_expires_at_ms'],renewed['turn']['lease_expires_at_ms'])

    def test_finish_commits_full_assistant_upstream_and_exact_retry(self):
        first=self.begin();done=self.finish(first)
        self.assertEqual(done['assistant_message']['content'],'完整回答🙂');self.assertEqual(done['turn']['state'],'done')
        self.assertEqual(done['session']['opencodeSessionId'],'upstream-1')
        self.assertIsNone(self.rows('trace_diagnosis_sessions')[0]['active_request_key'])
        self.assertEqual(self.finish(first)['turn']['revision'],done['turn']['revision'])
        with self.assertRaises(Conflict):self.finish(first,content='different')
        history=self.api.get_session(self.tokens['alice'],'w','execution')
        self.assertEqual([m['role'] for m in history['messages']],['user','assistant'])
        self.assertTrue(all(m['opencodeSessionId']=='upstream-1' for m in history['messages']))

    def test_terminal_failure_keeps_partial_and_never_adds_second_assistant(self):
        first=self.begin();done=self.finish(first,state='failed',content='实际部分正文',error_code='model_error',opencode_session_id=None)
        self.assertEqual(done['assistant_message']['content'],'实际部分正文');self.assertEqual(done['turn']['state'],'failed')
        self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)
        with self.assertRaises(Conflict):self.api.checkpoint(self.tokens['alice'],'w',first['session']['id'],**self.handle(first),expected_revision=done['turn']['revision'],content='late')

    def test_expired_lease_is_fenced_and_preserves_old_partial_after_restart(self):
        first=self.begin(lease_ms=1000)
        self.api.checkpoint(self.tokens['alice'],'w',first['session']['id'],**self.handle(first),expected_revision=1,content='partial')
        self.now+=1001
        for method,kw in [(self.api.checkpoint,dict(expected_revision=2,content='late')),(self.api.renew,{})]:
            with self.assertRaises(Conflict):method(self.tokens['alice'],'w',first['session']['id'],**self.handle(first),**kw)
        second=self.begin('new',lease_owner='new-worker')
        self.assertGreater(second['turn']['fence'],first['turn']['fence'])
        with self.assertRaises(Conflict):self.finish(first,expected_revision=2)
        history=self.api.get_session(self.tokens['alice'],'w','task')['messages']
        self.assertEqual(history[1]['state'],'interrupted');self.assertEqual(history[1]['content'],'partial')
        restarted=type(self.api)(self.control)
        self.assertEqual(restarted.get_session(self.tokens['alice'],'w','task')['messages'],history)

    def test_handle_actor_owner_and_fence_cannot_be_substituted(self):
        first=self.begin()
        for changed in ({'request_key':'wrong'},{'lease_owner':'wrong'},{'turn_fence':999}):
            with self.subTest(changed=changed),self.assertRaises(Conflict):
                self.api.checkpoint(self.tokens['alice'],'w',first['session']['id'],**dict(self.handle(first),**changed),expected_revision=1,content='bad')
        with self.assertRaises(Forbidden):self.api.renew(self.tokens['admin'],'w',first['session']['id'],**self.handle(first))

    def test_upstream_default_null_and_known_historical_branch(self):
        first=self.begin(opencode_session_id=None);self.assertIsNone(first['opencode_session_id']);self.finish(first)
        default=self.begin('default');self.assertEqual(default['opencode_session_id'],'upstream-1');self.finish(default,opencode_session_id='upstream-1')
        new=self.begin('new',opencode_session_id=None);self.assertIsNone(new['opencode_session_id']);self.finish(new,opencode_session_id='upstream-2')
        old=self.begin('old',opencode_session_id='upstream-1');self.assertEqual(old['opencode_session_id'],'upstream-1')
        self.finish(old,opencode_session_id='upstream-1')
        self.assertTrue(self.begin('new',opencode_session_id=None)['duplicate'])
        with self.assertRaises(Conflict):self.begin('forged',opencode_session_id='other-users-session')

    def test_cross_actor_upstream_continuation_rejects_before_allocating_messages(self):
        first=self.begin();self.finish(first)
        for options in ({},{'opencode_session_id':'upstream-1'}):
            with self.subTest(options=options),self.assertRaises(Conflict):self.begin('admin',token=self.tokens['admin'],**options)
        self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)
        own=self.begin('admin-new',token=self.tokens['admin'],opencode_session_id=None)
        self.assertEqual(own['principal_id'],'admin');self.assertIsNone(own['upstream_principal_id'])
        self.assertEqual(len(self.api.get_session(self.tokens['admin'],'w','task')['messages']),4)

    def test_known_upstream_actor_is_returned_from_ledger(self):
        first=self.begin();self.finish(first)
        own=self.begin('next')
        self.assertEqual(own['upstream_principal_id'],'alice')

    def test_terminal_user_upstream_cannot_be_attached_after_completion(self):
        first=self.begin(opencode_session_id=None)
        self.finish(first,state='failed',error_code='model_error',opencode_session_id=None)
        with self.assertRaises(StorageError):
            with self.control.transaction() as con:
                con.execute("UPDATE trace_diagnosis_messages SET opencode_session_id='fake',revision=revision+1 WHERE role='user'")

    def test_ensure_binding_is_cas_known_only_and_cannot_reset_active_turn(self):
        first=self.begin();self.finish(first)
        old=self.api.get_session(self.tokens['alice'],'w','task')['session']
        with self.assertRaises(Conflict):self.api.ensure_session(self.tokens['alice'],'w','task',opencode_session_id='unknown')
        with self.assertRaises(Conflict):self.api.ensure_session(self.tokens['alice'],'w','task',opencode_session_id=None,expected_revision=1)
        reset=self.api.ensure_session(self.tokens['alice'],'w','task',opencode_session_id=None,expected_revision=old['revision'])
        self.assertIsNone(reset['session']['opencodeSessionId'])
        self.begin('active')
        with self.assertRaises(Conflict):self.api.ensure_session(self.tokens['alice'],'w','task',opencode_session_id='upstream-1')

    def test_shared_read_admin_read_and_write_boundaries(self):
        self.begin();self.iam.share_resource(self.tokens['alice'],'w','trace','trace','bob')
        self.assertEqual(len(self.api.get_session(self.tokens['bob'],'w','task')['messages']),2)
        self.assertEqual(len(self.api.get_session(self.tokens['admin'],'w','task')['messages']),2)
        for actor in ('bob','viewer'):
            with self.subTest(actor=actor),self.assertRaises(Forbidden):self.begin('attack',token=self.tokens[actor])
        with self.assertRaises(Forbidden):self.api.get_session(self.tokens['alice'],'foreign','task')

    def test_write_only_and_read_only_keys_cannot_begin(self):
        for capabilities in (['write'],['read']):
            token=self.iam.issue_api_credential(self.tokens['alice'],'w',capabilities)
            with self.subTest(capabilities=capabilities),self.assertRaises(Forbidden):self.begin(token=token)
        self.assertEqual(self.rows('trace_diagnosis_sessions'),[])

    def test_current_revocation_and_deletion_barrier_block_all_turn_updates(self):
        first=self.begin();self.iam.revoke_credential(self.tokens['alice'])
        with self.assertRaises(Unauthorized):self.finish(first)
        fresh=self.iam.issue_session_for_provisioning('alice');self.tokens['alice']=fresh
        self.meta.delete(fresh,'w','trace')
        for method,args,kw in [(self.api.get_session,('task',),{}),(self.api.renew,(first['session']['id'],),self.handle(first))]:
            with self.subTest(method=method.__name__),self.assertRaises(Conflict):method(fresh,'w',*args,**kw)

    def test_explicit_barrier_alone_blocks_active_route(self):
        self.begin()
        with self.control.transaction() as con:
            con.execute("INSERT INTO deletion_requests VALUES('w','delete','trace','trace',1,2,'requested','alice',100000,100000)")
        with self.assertRaises(Conflict):self.api.get_session(self.tokens['alice'],'w','task')

    def test_session_and_message_revisions_and_allocation_rollback_on_failure(self):
        first=self.begin();session=self.rows('trace_diagnosis_sessions')[0]
        with self.assertRaises(Conflict):self.begin('another',expected_revision=session['revision']-1)
        self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)
        self.assertEqual(self.rows('trace_diagnosis_sessions')[0]['next_sequence'],3)

    def test_content_and_history_budgets_fail_without_truncating(self):
        module=importlib.import_module('services.storage.diagnosis')
        with patch.object(module,'MAX_USER_BYTES',3),self.assertRaises(module.DiagnosisTooLarge):self.begin(message='字字')
        self.assertEqual(self.rows('trace_diagnosis_messages'),[])
        first=self.begin()
        with patch.object(module,'MAX_ASSISTANT_BYTES',3),self.assertRaises(module.DiagnosisTooLarge):self.finish(first,content='字字')
        with patch.object(module,'MAX_HISTORY_BYTES',100),self.assertRaises(module.DiagnosisTooLarge):self.api.get_session(self.tokens['alice'],'w','task')
        self.assertEqual(len(self.rows('trace_diagnosis_messages')),2)

    def test_input_validation_and_ambiguous_aliases_have_no_side_effect(self):
        for changes in ({'evidence_hash':'BAD'},{'lease_ms':0},{'lease_ms':True},{'message':''},{'lease_owner':''},{'context_hash':'bad'}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.begin(**changes)
        self.meta.register_aliases_for_provisioning('w','other',execution_id='task')
        with self.assertRaises(Conflict):self.begin()
        self.assertEqual(self.rows('trace_diagnosis_messages'),[])

    def test_internal_id_and_legacy_alias_collision_is_ambiguous(self):
        with self.control.transaction() as con:
            con.execute("INSERT INTO trace_legacy_ids VALUES('w','task','trace','other',100001)")
        with self.assertRaises(Conflict):self.begin(ref='trace')
        self.assertEqual(self.rows('trace_diagnosis_messages'),[])

    def test_domain_errors_keep_http_status(self):
        module=importlib.import_module('services.storage.diagnosis')
        self.assertEqual(module.DiagnosisNotFound.status,404)
        self.assertEqual(module.DiagnosisTooLarge.status,413)

    def test_sixth_catalog_exact_columns_and_sql_constraints(self):
        root=Path(__file__).parents[1]/'schema';catalog=json.loads((root/'diagnosis-catalog.json').read_text())
        self.assertEqual(catalog['version'],6);self.assertEqual(len(catalog['tables']),2)
        first=self.begin();sid=first['session']['id']
        with self.control.read_transaction() as con:
            self.assertGreaterEqual(con.execute('SELECT MAX(version) FROM schema_meta').fetchone()[0],6)
            for table in catalog['tables']:
                if not hasattr(self.control,'schema'):actual=[r['name'] for r in con.execute('PRAGMA table_info('+table['name']+')')]
                else:actual=[r[0] for r in con.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',(self.control.schema,table['name']))]
                self.assertEqual(actual,[c['name'] for c in table['columns']])
        for sql in ("UPDATE trace_diagnosis_sessions SET revision=0","UPDATE trace_diagnosis_sessions SET next_sequence=0","UPDATE trace_diagnosis_sessions SET lease_owner=NULL","UPDATE trace_diagnosis_sessions SET trace_id='other'","UPDATE trace_diagnosis_messages SET session_id='missing'","UPDATE trace_diagnosis_messages SET workspace_id='foreign'","UPDATE trace_diagnosis_messages SET content='changed' WHERE role='user'","DELETE FROM trace_diagnosis_messages"):
            with self.subTest(sql=sql),self.assertRaises(StorageError):
                with self.control.transaction() as con:con.execute(sql)
        self.finish(first)
        with self.assertRaises(StorageError):
            with self.control.transaction() as con:con.execute("UPDATE trace_diagnosis_messages SET content='changed',revision=revision+1 WHERE role='assistant'")

    def test_read_revalidates_acl_after_serialization(self):
        self.begin();module=importlib.import_module('services.storage.diagnosis');original=module._bounded;changed=False
        def revoke(*args,**kwargs):
            nonlocal changed
            value=original(*args,**kwargs)
            if not changed:changed=True;self.iam.revoke_credential(self.tokens['alice'])
            return value
        with patch.object(module,'_bounded',side_effect=revoke),self.assertRaises(Unauthorized):self.api.get_session(self.tokens['alice'],'w','task')


if __name__=='__main__':unittest.main()
