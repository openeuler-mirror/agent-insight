import copy
import importlib.util
import unittest
from unittest.mock import patch
from services.storage.tests import test_datasets as fixture
from services.storage.control import Conflict
from services.storage.iam import Forbidden


def card(identity='custom-a'):
    return {'id':identity,'name':'judge','source':'custom','evaluatorType':'LLM','category':'res','llmConfig':{'model':'fixture','systemPrompt':'Judge {{reference_output}}','apiKey':'secret-value','skills':[{'name':'skill','snapshotHash':'a'*64,'opaque':False}]},'opaque':{'中文':[0.25,False,None],'headers':{'Authorization':'Bearer private'}}}


class EvaluatorAssetTests(unittest.TestCase):
    make_control=fixture.DatasetTests.make_control
    setUp=fixture.DatasetTests.setUp

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.evaluator_assets'),'versioned evaluator domain must exist')
        from services.storage.evaluator_assets import EvaluatorAssets
        return EvaluatorAssets(self.control)

    def save(self,service,cards=None,key='save',etag=None):
        return service.save(self.token,'w',cards or [card()],expected_etag=etag or service.read(self.token,'w')['etag'],operation_key=key)

    def test_full_authoring_round_trip_and_individual_sealed_versions(self):
        service=self.service();source=card();first=self.save(service)
        self.assertEqual(first['evaluators'],[source]);self.assertEqual(first,service.read(self.token,'w'))
        changed=copy.deepcopy(source);changed['llmConfig']['systemPrompt']='new rubric'
        second=self.save(service,[changed],key='second',etag=first['etag'])
        self.assertNotEqual(first['releases'][0]['release_id'],second['releases'][0]['release_id'])
        with self.control.read_transaction() as con:
            asset=first['releases'][0]['asset_id']
            self.assertEqual(con.execute('SELECT COUNT(*) FROM asset_releases WHERE workspace_id=? AND asset_id=?',('w',asset)).fetchone()[0],2)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM asset_release_seals WHERE workspace_id=? AND asset_id=?',('w',asset)).fetchone()[0],2)

    def test_stale_and_missing_etag_do_not_publish(self):
        service=self.service();empty=service.read(self.token,'w');first=self.save(service)
        with self.assertRaises(Conflict):self.save(service,key='stale',etag=empty['etag'])
        with self.assertRaises(ValueError):service.save(self.token,'w',[card()],expected_etag=None,operation_key='missing')
        self.assertEqual(service.read(self.token,'w'),first)

    def test_exact_replay_returns_original_result_after_new_save(self):
        service=self.service();before=service.read(self.token,'w')['etag'];first=self.save(service,etag=before)
        self.save(service,[card('custom-b')],key='second')
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('replay wrote artifact')):
            self.assertEqual(self.save(service,etag=before),first)
        with self.assertRaises(Conflict):self.save(service,etag=first['etag'])
        changed=card();changed['name']='different'
        with self.assertRaises(Conflict):self.save(service,[changed],etag=before)

    def test_freeze_is_lossless_for_business_fields_but_removes_runtime_secrets(self):
        service=self.service();self.save(service)
        frozen=service.freeze(self.token,'w',['custom-a'])
        value=frozen['cards']['custom-a'];self.assertEqual(value['opaque']['中文'],[0.25,False,None])
        self.assertEqual(value['llmConfig']['skills'],card()['llmConfig']['skills'])
        self.assertNotIn('apiKey',value['llmConfig']);self.assertNotIn('Authorization',value['opaque']['headers'])
        self.assertNotIn('secret-value',str(frozen));self.assertNotIn('Bearer private',str(frozen))
        self.assertEqual(frozen['releases'][0]['evaluator_id'],'custom-a')

    def test_removed_cards_stay_in_history_but_cannot_freeze_as_current(self):
        service=self.service();first=self.save(service)
        service.save(self.token,'w',[],expected_etag=first['etag'],operation_key='remove')
        with self.assertRaises(LookupError):service.freeze(self.token,'w',['custom-a'])
        with self.control.read_transaction() as con:self.assertIsNotNone(con.execute('SELECT 1 FROM asset_release_seals WHERE release_id=?',(first['releases'][0]['release_id'],)).fetchone())

    def test_scope_actor_and_read_write_capabilities_cannot_be_supplied_as_user(self):
        service=self.service();self.save(service)
        self.assertEqual(service.read(self.bob,'w')['evaluators'],[])
        readonly=self.iam.issue_api_credential(self.token,'w',{'read'})
        with patch.object(self.control,'persist_artifact',side_effect=AssertionError('unauthorized artifact write')),self.assertRaises(Forbidden):
            service.save(readonly,'w',[card()],expected_etag=service.read(readonly,'w')['etag'],operation_key='forged')

    def test_revoked_replay_and_read_postflight_do_not_return_cards(self):
        service=self.service();first=self.save(service);original=service._load;called=False
        def changed(*args,**kwargs):
            nonlocal called
            value=original(*args,**kwargs)
            if not called:called=True;self.iam.revoke_credential(self.token)
            return value
        from services.storage.iam import Unauthorized
        with patch.object(service,'_load',side_effect=changed),self.assertRaises(Unauthorized):service.read(self.token,'w')
        with self.assertRaises(Unauthorized):service.save(self.token,'w',[card()],expected_etag=first['etag'],operation_key='save')

    def test_duplicates_and_invalid_json_are_rejected_before_artifacts(self):
        service=self.service()
        invalid=card();invalid['opaque']['bad']=float('nan')
        for values in ([card(),card()],[invalid]):
            with patch.object(self.control,'persist_artifact',side_effect=AssertionError('invalid artifact write')),self.assertRaises(ValueError):
                service.save(self.token,'w',values,expected_etag=service.read(self.token,'w')['etag'],operation_key='invalid')

    def test_original_request_receipt_can_recover_normalization_without_import_token(self):
        service=self.service();etag=service.read(self.token,'w')['etag'];request={'evaluators':[{'id':'custom-a','importToken':'temporary'}]}
        first=service.save(self.token,'w',[card()],expected_etag=etag,operation_key='import',operation_request=request)
        self.assertEqual(service.lookup(self.token,'w',operation_key='import',expected_etag=etag,operation_request=request),first)
        with self.assertRaises(Conflict):service.lookup(self.token,'w',operation_key='import',expected_etag=first['etag'],operation_request=request)

    def test_runtime_secret_matching_handles_camel_case_and_url_credentials(self):
        service=self.service();value=card();value['opaque'].update(modelApiKey='secret-model',nested={'clientSecret':'hidden'},url='https://user:pass@example.test/v1?api_key=hidden&mode=test')
        self.save(service,[value]);frozen=service.freeze(self.token,'w',['custom-a']);safe=frozen['cards']['custom-a']['opaque']
        self.assertNotIn('modelApiKey',safe);self.assertNotIn('clientSecret',safe['nested']);self.assertEqual(safe['url'],'https://example.test/v1?mode=test')

    def test_card_identity_cannot_collide_with_internal_list_namespace(self):
        service=self.service();saved=self.save(service,[card('__list__')])
        self.assertEqual(service.freeze(self.token,'w',['__list__'])['cards']['__list__']['id'],'__list__')
        self.assertNotEqual(saved['releases'][0]['asset_id'],saved['etag'].split(':')[1])

    def test_manifest_and_operation_envelope_budget_precedes_any_sql_publication(self):
        service=self.service();etag=service.read(self.token,'w')['etag']
        with patch('services.storage.evaluator_assets.MAX_LIST_BYTES',512),self.assertRaises(ValueError):
            service.save(self.token,'w',[card()],expected_etag=etag,operation_key='envelope-too-large')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM asset_identities').fetchone()[0],0)

    def test_user_card_claim_cannot_become_builtin_runtime_authority(self):
        service=self.service();value=card();value['source']='preset';saved=self.save(service,[value])
        self.assertEqual(saved['evaluators'][0]['source'],'preset')
        frozen=service.freeze(self.token,'w',['custom-a'])
        self.assertEqual(frozen['cards']['custom-a']['source'],'custom');self.assertEqual(frozen['releases'][0]['origin'],'user')

    def test_secret_scrubbing_preserves_ordinary_prompt_and_url_bytes(self):
        service=self.service();value=card();value['llmConfig']['systemPrompt']='https://[literal rubric';value['opaque']['url']='https://example.test/a?name=a%20b&v=%2f'
        self.save(service,[value]);frozen=service.freeze(self.token,'w',['custom-a'])['cards']['custom-a']
        self.assertEqual(frozen['llmConfig']['systemPrompt'],value['llmConfig']['systemPrompt']);self.assertEqual(frozen['opaque']['url'],value['opaque']['url'])

    def test_same_operation_racing_preparation_publishes_only_one_list_and_card_release(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        service=self.service();etag=service.read(self.token,'w')['etag'];barrier=Barrier(2);original=service._persist
        def synchronized(value):
            artifact=original(value)
            if value.get('format')=='agent-insight.evaluator-definition':barrier.wait(timeout=10)
            return artifact
        with patch.object(service,'_persist',side_effect=synchronized),ThreadPoolExecutor(max_workers=2) as workers:
            futures=[workers.submit(service.save,self.token,'w',[card()],expected_etag=etag,operation_key='racing') for _ in range(2)]
            results=[future.result(timeout=20) for future in futures]
        self.assertEqual(results[0],results[1])
        with self.control.read_transaction() as con:
            self.assertEqual(con.execute('SELECT COUNT(*) FROM asset_releases').fetchone()[0],3)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM asset_aliases').fetchone()[0],2)

    def test_runtime_secret_scrubbing_accepts_case_insensitive_url_schemes(self):
        service=self.service();value=card();value['opaque']['url']='HTTPS://user:pass@example.test/v1?api_key=hidden&mode=test'
        self.save(service,[value]);frozen=service.freeze(self.token,'w',['custom-a'])
        self.assertEqual(frozen['cards']['custom-a']['opaque']['url'],'https://example.test/v1?mode=test')

    def test_new_operation_lookup_rejects_stale_list_before_import_normalization(self):
        service=self.service();stale=service.read(self.token,'w')['etag'];self.save(service)
        with self.assertRaises(Conflict):
            service.lookup(self.token,'w',operation_key='stale-import',expected_etag=stale,operation_request={'importToken':'expired'})
