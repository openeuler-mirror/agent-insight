import hashlib
import unittest
from services.storage.tests import test_collector_sources as source_tests
from services.storage.platform_controls import PlatformControls
from services.storage.iam import Forbidden, Unauthorized
from services.storage.legacy_history import INERT_SOURCE, control_history_key

class BackgroundActorTests(unittest.TestCase):
    def setUp(self):
        self.fixture=source_tests.CollectorSourceTests('runTest');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.control=self.fixture.control;self.iam=self.fixture.iam;self.service=PlatformControls(self.control)
        self.user=self.service.bootstrap_login({'action':'login','mode':'standalone','username':'New.Owner'})
        self.scope=self.iam.scope(self.user['apiKey']);self.workspace=self.scope.allowed_workspace_ids[0]
    def actors(self,**extra):return self.service.background_actors({'action':'background_actors',**extra})
    def reference(self,actor):return {'action':'background_actor','user_record_id':actor['user_record_id'],'principal_id':actor['principal'],'workspace_id':actor['workspace'],'username':actor['username'],'credential_sha256':hashlib.sha256(actor['token'].encode()).hexdigest()}
    def replace_key(self,key):
        with self.control.transaction() as con:
            scope,grant=self.service._scope(con,self.user['apiKey'],self.workspace,'write')
            self.service._put(con,scope,grant,self.workspace,self.user['username'],{'kind':'user','method':'update','record_id':self.user['id'],'data':{'apiKey':key}})
    def test_new_user_is_recovered_from_durable_verified_credential_without_mapping(self):
        first=self.actors()['actors'][0]
        self.assertEqual((first['username'],first['principalUsername']),('New.Owner','new.owner'))
        self.assertEqual(first['token'],self.user['apiKey']);self.assertEqual(first['workspace'],self.workspace)
        restored=PlatformControls(self.control).background_actors(self.reference(first))
        self.assertEqual(restored,first)
        self.assertEqual(self.actors(capability='execute')['actors'],[first])
    def test_current_capabilities_revocation_and_owner_are_not_inferred_from_record(self):
        login=self.iam.issue_session_for_provisioning(self.scope.principal_id)
        write=self.iam.issue_api_credential(login,self.workspace,['write']);self.replace_key(write)
        self.assertEqual(len(self.actors()['actors']),1);self.assertEqual(self.actors(capability='execute')['actors'],[])
        self.iam.revoke_credential(write);self.assertEqual(self.actors()['actors'],[])
        with self.assertRaises(Unauthorized):self.service.background_actors({'action':'background_actor','user_record_id':self.user['id'],'principal_id':self.scope.principal_id,'workspace_id':self.workspace,'username':self.user['username'],'credential_sha256':hashlib.sha256(write.encode()).hexdigest()})
    def test_rotated_reference_and_expired_credentials_are_rejected(self):
        previous=self.reference(self.actors()['actors'][0])
        login=self.iam.issue_session_for_provisioning(self.scope.principal_id)
        replacement=self.iam.issue_api_credential(login,self.workspace,['write','execute'],ttl_ms=1)
        self.replace_key(replacement)
        with self.assertRaises(Forbidden):self.service.background_actors(previous)
        self.assertEqual(self.actors()['actors'][0]['token'],replacement)
        now=self.control.clock();self.service.iam.clock=lambda:now+1
        self.assertFalse(self.actors()['actors'])
    def test_readonly_wrong_owner_wrong_workspace_and_inert_are_rejected(self):
        login=self.iam.issue_session_for_provisioning(self.scope.principal_id)
        readonly=self.iam.issue_api_credential(login,self.workspace,['read']);self.replace_key(readonly)
        self.assertEqual(self.actors()['actors'],[])
        foreign=self.iam.issue_api_credential(self.fixture.tokens['bob'],'w',['read','write','execute']);self.replace_key(foreign)
        self.assertEqual(self.actors()['actors'],[])
        other_workspace=self.iam.issue_api_credential(self.fixture.tokens['alice'],'w',['write','execute']);self.replace_key(other_workspace)
        self.assertEqual(self.actors()['actors'],[])
        self.replace_key(self.user['apiKey'])
        with self.control.transaction() as con:con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',(self.workspace,INERT_SOURCE,control_history_key('user',self.user['id']),'a'*64,self.control.clock()))
        self.assertEqual(self.actors()['actors'],[])
    def test_selectors_are_fixed_and_reference_cannot_switch_owner_or_key(self):
        actor=self.actors()['actors'][0];reference=self.reference(actor)
        for changed in ({'principal_id':'bob'},{'username':'other'},{'credential_sha256':'a'*64},{'workspace_id':'w'}):
            with self.subTest(changed=changed),self.assertRaises(Forbidden):self.service.background_actors({**reference,**changed})
        for body in ({'action':'background_actors','where':{}},{'action':'background_actors','capability':'members'},{'action':'background_actor','username':'other'}):
            with self.subTest(body=body),self.assertRaises(ValueError):self.service.background_actors(body)
    def test_collector_tag_projection_requires_write_and_returns_only_selected_owner_metadata(self):
        self.service.dispatch(self.fixture.tokens['alice'],'w','records_batch',{'legacy_username':'alice','operation_key':'tag','operations':[{'kind':'skillGeneratorSession','method':'create','data':{'id':'generator','user':'alice','opencodeSessionId':'source-session','agentName':'agent','agentTraceSkill':'skill','files':'{"private":"body"}'}}]},trusted=True)
        body={'opencode_session_id':'source-session'}
        value=self.service.dispatch(self.fixture.api,'w','collector_agent_tag',body,trusted=True,preparation=True)
        self.assertEqual(value,{'tag':{'agentName':'agent','agentTraceSkill':'skill','user':'alice'}})
        self.assertEqual(self.service.dispatch(self.fixture.tokens['admin'],'w','collector_agent_tag',body,trusted=True,preparation=True),{'tag':None})
        with self.assertRaises(Forbidden):self.service.dispatch(self.fixture.api,'w','collector_agent_tag',body,trusted=True)
        with self.assertRaises(Forbidden):self.service.dispatch(self.fixture.api,'w','collector_agent_tag',body,preparation=True)
