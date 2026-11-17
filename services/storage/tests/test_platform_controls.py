import copy
import importlib.util
import unittest
from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_collector_sources as source_tests

class PlatformControlTests(unittest.TestCase):
    def setUp(self):
        self.fixture=source_tests.CollectorSourceTests('runTest');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.control=self.fixture.control;self.iam=self.fixture.iam
        self.api=self.iam.issue_api_credential(self.fixture.tokens['alice'],'w',['read','write','execute','delete'])
        self.bob=self.iam.issue_api_credential(self.fixture.tokens['bob'],'w',['read','write'])
        self.readonly=self.iam.issue_api_credential(self.fixture.tokens['alice'],'w',['read'])
    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.platform_controls'),'fixed control repository required')
        from services.storage.platform_controls import PlatformControls
        return PlatformControls(self.control)
    def read(self,kind,**kw):return self.service().dispatch(self.api,'w','records_read',{'kind':kind,**kw},trusted=True)
    def write(self,ops,**kw):return self.service().dispatch(self.api,'w','records_batch',{'legacy_username':'alice','operation_key':kw.pop('operation_key','one'),'operations':ops,**kw},trusted=True)
    def test_fixed_contract_preserves_zero_null_and_rejects_query_language(self):
        result=self.write([{'kind':'registeredAgent','method':'create','data':{'id':'a','name':'agent','platform':'codex','user':'alice'}}]);self.assertEqual(result['results'][0]['id'],'a')
        rows=self.read('registeredAgent',ids=['a'],body=True)['rows'];self.assertEqual(rows[0]['data']['user'],'alice')
        with self.assertRaises(ValueError):self.read('registeredAgent',where={'user':'alice'})
        with self.assertRaises(ValueError):self.read('not_a_model')
    def test_capability_owner_and_private_settings_do_not_expand_via_controller(self):
        data={'id':'setting','user':'alice','settingsJson':'{"configs":[{"apiKey":"PRIVATE"}],"autoEvaluationEnabled":false}'}
        self.write([{'kind':'userSettings','method':'create','data':data}])
        with self.assertRaises(Forbidden):self.service().dispatch(self.readonly,'w','records_batch',{'legacy_username':'alice','operation_key':'denied','operations':[]},trusted=True)
        with self.assertRaises(Forbidden):self.service().dispatch(self.bob,'w','records_read',{'kind':'userSettings','ids':['setting'],'body':True},trusted=True)
        with self.assertRaises(Forbidden):self.service().dispatch(self.api,'w','records_read',{'kind':'userSettings','ids':['setting'],'body':True},trusted=False)
        self.assertNotIn('PRIVATE',str(self.read('userSettings')['rows']))
    def test_atomic_parent_unique_and_stale_cas(self):
        self.write([{'kind':'skillWorkbenchSession','method':'create','data':{'id':'s','user':'alice'}},{'kind':'skillWorkbenchTask','method':'create','data':{'id':'t','sessionId':'s','type':'evaluation','idempotencyKey':'same'}}])
        revision=self.read('skillWorkbenchSession',ids=['s'])['rows'][0]['revision']
        with self.assertRaises(Conflict):self.write([{'kind':'skillWorkbenchSession','method':'update','record_id':'s','expected_revision':revision,'data':{'title':'must rollback'}},{'kind':'skillWorkbenchTask','method':'create','data':{'id':'other','sessionId':'s','type':'evaluation','idempotencyKey':'same'}}],operation_key='duplicate')
        self.assertEqual(self.read('skillWorkbenchSession',ids=['s'],body=True)['rows'][0]['data']['title'],'新对话')
        with self.assertRaises(Conflict):self.write([{'kind':'skillWorkbenchTask','method':'create','data':{'id':'orphan','sessionId':'missing','type':'evaluation','idempotencyKey':'x'}}],operation_key='orphan')
    def test_soft_delete_cascades_original_relations_and_keeps_artifacts(self):
        self.write([{'kind':'skillGeneratorSession','method':'create','data':{'id':'s','user':'alice'}},{'kind':'skillGeneratorMessage','method':'create','data':{'id':'m','sessionId':'s','role':'user','content':'complete body'}}])
        with self.control.read_transaction() as con:artifact=con.execute("SELECT payload_ref FROM platform_control_records WHERE kind='skillGeneratorMessage'").fetchone()[0]
        self.write([{'kind':'skillGeneratorSession','method':'delete','record_id':'s'}],operation_key='delete')
        self.assertEqual(self.read('skillGeneratorMessage',parents=['s'],body=True)['rows'],[])
        self.assertIsNotNone(self.service()._load(artifact))
    def test_write_only_collector_can_capture_own_policy_but_not_general_secrets(self):
        self.write([{'kind':'userSettings','method':'create','data':{'id':'setting','user':'alice','settingsJson':'{"autoEvaluationEnabled":false}'}}])
        value=self.service().dispatch(self.fixture.api,'w','records_read',{'kind':'userSettings','ids':['setting'],'body':True},trusted=True,preparation=True)
        self.assertEqual(value['rows'][0]['data']['settingsJson'],'{"autoEvaluationEnabled":false}')
        with self.assertRaises(Forbidden):self.service().dispatch(self.fixture.api,'w','records_read',{'kind':'userSettings','ids':['setting'],'body':True},trusted=True)
        with self.assertRaises(Forbidden):self.service().dispatch(self.fixture.api,'w','records_read',{'kind':'reliabilityCommand','body':True},trusted=True,preparation=True)
    def test_skill_zero_version_reuses_asset_release_and_keeps_first_release(self):
        self.write([{'kind':'skill','method':'create','data':{'id':'skill','name':'same','user':'alice'}},{'kind':'skillVersion','method':'create','data':{'id':'v0','skillId':'skill','version':0,'content':'first'}}])
        with self.control.read_transaction() as con:first=con.execute("SELECT release_id FROM asset_aliases WHERE alias='version:0'").fetchone()[0]
        row=self.read('skillVersion',ids=['v0'],body=True)['rows'][0]
        self.write([{'kind':'skillVersion','method':'update','record_id':'v0','expected_revision':row['revision'],'data':{'content':'second'}}],operation_key='edit')
        self.assertEqual(self.read('skillVersion',ids=['v0'],body=True)['rows'][0]['data']['content'],'second')
        with self.control.read_transaction() as con:
            self.assertIsNotNone(con.execute('SELECT 1 FROM asset_releases WHERE release_id=?',(first,)).fetchone());self.assertNotEqual(con.execute("SELECT release_id FROM asset_aliases WHERE alias='version:0'").fetchone()[0],first)
    def test_local_bootstrap_preserves_existing_key_and_has_only_personal_role(self):
        service=self.service();user=service.bootstrap_login({'action':'login','mode':'standalone','username':'New.Owner'})
        self.assertTrue(user['_created']);again=service.bootstrap_login({'action':'login','mode':'standalone','username':'New.Owner'});self.assertFalse(again['_created']);self.assertEqual(user['apiKey'],again['apiKey'])
        scope=self.iam.scope(user['apiKey']);self.assertEqual([grant.role for grant in scope.grants],['personal'])
        self.assertNotIn('members',scope.capabilities)
        from services.storage.iam import Unauthorized
        self.iam.revoke_credential(user['apiKey'])
        with self.assertRaises(Unauthorized):service.bootstrap_login({'action':'login','mode':'standalone','username':'New.Owner'})

    def client_capability(self,client='client',credential='a'*64):
        self.write([{'kind':'reliabilityClient','method':'create','data':{'id':client,'clientId':client,'user':'alice','name':client,'lastSeenAt':'2026-11-17T00:00:00.000Z'}},{'kind':'reliabilityClientCredential','method':'create','data':{'id':'credential-'+client,'clientId':client,'credentialHash':credential}}],operation_key='client-'+client)
        return {'type':'device','credential_hash':credential,'client_id':client}

    def test_device_capability_is_actual_owner_and_never_a_general_settings_actor(self):
        capability=self.client_capability();identity=self.service().capability_dispatch({'action':'identity','capability':capability})
        self.assertEqual(identity['username'],'alice');self.assertEqual(identity['client_id'],'client');self.assertNotIn('token',identity)
        with self.assertRaises(Forbidden):self.service().capability_dispatch({'action':'records_read','kind':'userSettings','body':True,'capability':capability})
        with self.assertRaises(Forbidden):self.service().capability_dispatch({'action':'scope','capabilities':['execute'],'capability':capability})
        self.client_capability('other','b'*64)
        rows=self.service().capability_dispatch({'action':'records_read','kind':'reliabilityClient','body':True,'capability':capability})['rows']
        self.assertEqual([row['data']['clientId'] for row in rows],['client'])
        self.write([{'kind':'reliabilityClientCredential','method':'update','record_id':'credential-client','data':{'revokedAt':'2026-11-17T00:01:00.000Z'}}],operation_key='revoke')
        with self.assertRaises(Forbidden):self.service().capability_dispatch({'action':'identity','capability':capability})

    def test_install_token_is_consumed_with_client_and_replay_does_not_create_another(self):
        self.write([{'kind':'reliabilityInstallToken','method':'create','data':{'id':'install','tokenHash':'c'*64,'user':'alice','expiresAt':'2026-11-19T00:00:00.000Z'}}],operation_key='install')
        capability={'type':'install','token_hash':'c'*64};identity=self.service().capability_dispatch({'action':'identity','capability':capability});self.assertEqual(identity['principal'],'alice')
        value={'action':'records_batch','capability':capability,'legacy_username':'alice','operation_key':'register','operations':[{'kind':'reliabilityClient','method':'create','data':{'id':'new','clientId':'new','user':'alice','name':'new','lastSeenAt':'2026-11-17T00:00:00.000Z'}},{'kind':'reliabilityClientCredential','method':'create','data':{'id':'dc','clientId':'new','credentialHash':'d'*64}},{'kind':'reliabilityInstallToken','method':'update','record_id':'install','data':{'consumedAt':'2026-11-17T00:00:00.000Z','clientId':'new'}}]}
        self.service().capability_dispatch(value)
        with self.assertRaises(Forbidden):self.service().capability_dispatch({'action':'identity','capability':capability})
        self.assertEqual(self.service().capability_dispatch({'action':'identity','capability':{'type':'device','credential_hash':'d'*64}})['client_id'],'new')

    def test_one_active_task_and_unrelated_kind_does_not_invalidate_settings_cas(self):
        revision=self.read('userSettings')['scope_revision'];self.client_capability()
        self.write([{'kind':'userSettings','method':'create','data':{'user':'alice','settingsJson':'{}'}}],operation_key='setting-cas',expected_kind_revisions={'userSettings':revision})
        self.write([{'kind':'skillWorkbenchSession','method':'create','data':{'id':'s','user':'alice'}},{'kind':'skillWorkbenchTask','method':'create','data':{'id':'first','sessionId':'s','type':'optimization','idempotencyKey':'one'}}],operation_key='active')
        with self.assertRaises(Conflict):self.write([{'kind':'skillWorkbenchTask','method':'create','data':{'id':'second','sessionId':'s','type':'optimization','idempotencyKey':'other'}}],operation_key='second-active')

    def test_binary_skill_files_modes_and_zero_version_remain_durable(self):
        import base64
        files=[{'path':'run.sh','content':base64.b64encode(b'\x00binary\xff').decode(),'mode':493}]
        self.write([{'kind':'skill','method':'create','data':{'id':'skill','name':'files','user':'alice'}},{'kind':'skillVersion','method':'create','file_bundle':files,'data':{'id':'version','skillId':'skill','version':0,'content':'body','files':'["run.sh"]'}}],operation_key='files')
        row=self.read('skillVersion',ids=['version'],fields=['files'])['rows'][0];self.assertEqual(row['file_bundle'],files)
        self.assertNotIn('file_bundle',self.read('skillVersion',ids=['version'],fields=['content'])['rows'][0])
        with self.assertRaises(ValueError):self.write([{'kind':'skillVersion','method':'update','record_id':'version','file_bundle':[{'path':'../escape','content':'','mode':0}],'data':{}}],operation_key='unsafe-file')

    def test_agent_delete_uses_trace_deletion_barrier_and_retains_source_artifacts(self):
        reserved=self.fixture.reserve();self.fixture.commit(reserved);self.fixture.drain();trace=self.fixture.service().status(self.fixture.api,'w',{'task_id':'task','operation_key':'one'})['trace_id']
        self.write([{'kind':'registeredAgent','method':'create','data':{'id':'agent','name':'agent','platform':'pi-agent','user':'alice'}}],operation_key='agent')
        value=self.service().dispatch(self.api,'w','agent_delete',{'agent_id':'agent','trace_ids':[trace]},trusted=True);self.assertEqual(value['deletedTraces'],1)
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT state FROM trace_locators WHERE trace_id=?',(trace,)).fetchone()[0],'deleting')
            self.assertEqual(con.execute("SELECT state FROM platform_control_records WHERE kind='registeredAgent' AND record_id='agent'").fetchone()[0],'deleted')
            self.assertGreater(con.execute('SELECT COUNT(*) FROM obs_entity_heads WHERE trace_id=?',(trace,)).fetchone()[0],0)
    def test_cross_workspace_handoff_requires_real_old_device_proof(self):
        import hashlib
        oldcap=self.client_capability()
        user=self.service().bootstrap_login({'action':'login','mode':'standalone','username':'new-owner'})
        scope=self.iam.scope(user['apiKey']);workspace=scope.allowed_workspace_ids[0]
        self.service().dispatch(user['apiKey'],workspace,'records_batch',{'legacy_username':'new-owner','operation_key':'other-install','operations':[{'kind':'reliabilityInstallToken','method':'create','data':{'id':'new-install','tokenHash':'e'*64,'user':'new-owner','expiresAt':'2026-11-19T00:00:00.000Z'}}]},trusted=True)
        cap={'type':'install','token_hash':'e'*64}
        selected={'action':'records_read','kind':'reliabilityClient','metadata':{'clientId':'client'},'capability':cap}
        self.assertEqual(self.service().capability_dispatch(selected)['rows'],[])
        cap['previous_credential_hash']='a'*64
        selected['capability']=cap
        previous=self.service().capability_dispatch(selected)['rows'][0]
        self.assertEqual(previous['owner_principal_id'],'alice')
        self.service().capability_dispatch({'action':'records_batch','capability':cap,'legacy_username':'new-owner','operation_key':'handoff','operations':[{'kind':'reliabilityClient','method':'create','data':{'id':'replacement','clientId':'replacement','user':'new-owner','name':'replacement','lastSeenAt':'2026-11-17T00:00:00.000Z'}},{'kind':'reliabilityClient','method':'update','record_id':'client','expected_revision':previous['revision'],'data':{'unboundAt':'2026-11-17T00:00:00.000Z','unboundToClientId':'replacement','status':'offline'}},{'kind':'reliabilityInstallToken','method':'update','record_id':'new-install','data':{'consumedAt':'2026-11-17T00:00:00.000Z','clientId':'replacement'}}]})
        with self.assertRaises(Forbidden):self.service().capability_dispatch({'action':'identity','capability':oldcap})
