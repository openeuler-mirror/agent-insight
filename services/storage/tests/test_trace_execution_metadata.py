import json
import unittest
from unittest.mock import patch

from services.storage.compatibility_list import LegacyTraceList
from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.trace_evidence import TraceEvidence
from services.storage.tests import test_trace_analytics as analytics_fixture
from services.storage.tests import test_trace_transfer as fixture


class TraceExecutionMetadataTests(unittest.TestCase):
    setUp=analytics_fixture.TraceAnalyticsTests.setUp
    make_control=analytics_fixture.TraceAnalyticsTests.make_control
    drain=analytics_fixture.TraceAnalyticsTests.drain
    prepare_source=analytics_fixture.TraceAnalyticsTests.prepare_source
    service=analytics_fixture.TraceAnalyticsTests.service

    def read(self,trace,token=None,boundary=None):
        service=self.service()
        self.assertTrue(callable(getattr(service,'execution_metadata',None)),'bounded source execution metadata is required')
        with self.control.read_transaction() as con:current=service._boundary(con,self.token,'w',trace)[0]
        return service.execution_metadata(token or self.token,'w',[{'trace_id':trace,'boundary':boundary or current}])

    def listing(self):
        self.assertTrue(callable(getattr(self.service(),'execution_metadata',None)),'bounded source execution metadata is required')
        return LegacyTraceList(self.queries,self.metadata,analytics=self.service())

    def test_unjudged_execution_keeps_root_version_zero_and_historical_fields(self):
        node=fixture.node();node['execution'].update(skill='root-skill',skillVersion=0,
            executionSkills=[{'skillName':'child-skill','skillVersion':2,'isPrimary':True}],
            answerScore=0,skillScore=None,judgmentReason='original reason',isSkillCorrect=True,
            skillTriggerRate=0,expectedSkillVersion=0,failures='[]',skillIssues='[]')
        trace=self.prepare_source(fixture.bundle([node]))
        with patch.object(TraceEvidence,'read',side_effect=AssertionError('full Trace API loaded')):
            raw=self.read(trace)['items'][0]
            row=self.listing().read(self.token,'w',{})[0]
        self.assertEqual(raw['execution']['executionSkills'][0]['isPrimary'],True)
        self.assertNotIn('question',json.dumps(raw));self.assertNotIn('interactions',json.dumps(raw))
        self.assertEqual(row['root_skill'],{'name':'root-skill','version':0});self.assertEqual(row['rootSkill'],row['root_skill'])
        self.assertEqual(row['skill_version'],0);self.assertEqual(row['invokedSkills'],[{'name':'child-skill','version':2}])
        self.assertEqual(row['answer_score'],0);self.assertIsNone(row['skill_score']);self.assertEqual(row['judgment_reason'],'original reason')
        self.assertTrue(row['is_skill_correct']);self.assertEqual(row['skill_trigger_rate'],0);self.assertEqual(row['expected_skill_version'],0)
        self.assertEqual(row['failures'],[]);self.assertEqual(row['skill_issues'],[])

    def test_unknown_version_and_explicit_primary_are_never_inferred_from_child(self):
        for execution,expected in [
            ({'skill':'root-skill','skillVersion':None,'executionSkills':[{'skillName':'child','skillVersion':9,'isPrimary':True}]},{'name':'root-skill','version':None}),
            ({'executionSkills':[{'skillName':'child','skillVersion':9,'isPrimary':False}]},None),
            ({'executionSkills':[{'skillName':'primary','skillVersion':None,'isPrimary':True}]},{'name':'primary','version':None}),
        ]:
            with self.subTest(execution=execution):
                self.setUp()
                node=fixture.node();node['execution'].update(execution);self.prepare_source(fixture.bundle([node]))
                self.assertEqual(self.listing().read(self.token,'w',{})[0]['root_skill'],expected)

    def test_empty_relations_do_not_erase_captured_invocations_but_filters_keep_relation_semantics(self):
        node=fixture.node();node['execution'].update(skill='root',skillVersion=1,executionSkills=[],invokedSkills=[{'name':'captured','version':0}])
        self.prepare_source(fixture.bundle([node]));api=self.listing();row=api.read(self.token,'w',{})[0]
        self.assertEqual(row['skills'],['captured']);self.assertEqual(row['invoked_skills'],[{'name':'captured','version':0}])
        self.assertEqual(api.read(self.token,'w',{'skill':'root'}),[])
        self.assertEqual(api.read(self.token,'w',{'facet':'skills'}),[{'name':'root','versions':[1]}])

    def test_missing_relations_allow_real_execution_filter_and_null_version_remains_null(self):
        node=fixture.node();node['execution'].update(skill='root',skillVersion=None,invokedSkills=[{'name':'captured-call','version':8}])
        self.prepare_source(fixture.bundle([node]));api=self.listing()
        self.assertEqual(len(api.read(self.token,'w',{'skill':'root'})),1)
        self.assertEqual(api.read(self.token,'w',{'skill':'root','skillVersion':'1'}),[])
        self.assertEqual(api.read(self.token,'w',{'facet':'skills'}),[{'name':'root','versions':[]}])

    def test_source_and_authorization_changes_fail_closed(self):
        trace=self.prepare_source();value=self.read(trace)
        with self.assertRaises(Forbidden):self.read(trace,token=self.bob)
        self.metadata.patch(self.token,'w',trace,{'label':'changed'})
        with self.assertRaises(Conflict):self.read(trace,boundary=value['items'][0]['boundary'])
        from services.storage.dataset_generation_sources import GenerationSources
        original=GenerationSources._metadata
        def change(reader,*args):
            result=original(reader,*args);self.metadata.patch(self.token,'w',trace,{'label':'changed during read'});return result
        with patch.object(GenerationSources,'_metadata',change),self.assertRaises(Conflict):self.read(trace)

    def test_budget_applies_to_real_source_bytes_before_metadata_response(self):
        trace=self.prepare_source()
        self.assertTrue(callable(getattr(self.service(),'execution_metadata',None)),'bounded source execution metadata is required')
        with patch('services.storage.trace_analytics.MAX_EXECUTION_SOURCE_BYTES',1):
            from services.storage.trace_evidence import EvidenceTooLarge
            with self.assertRaises(EvidenceTooLarge):self.read(trace)

    def test_private_page_rejects_oversize_and_invalid_source_selections(self):
        trace=self.prepare_source();service=self.service();current=self.read(trace)['items'][0]['boundary']
        from services.storage.trace_analytics import AnalyticsTooLarge
        with patch('services.storage.trace_analytics.MAX_PAGE_BYTES',50),self.assertRaises(AnalyticsTooLarge):self.read(trace)
        for items in ([],[{'trace_id':trace,'boundary':current,'extra':True}],[{'trace_id':trace,'boundary':current}]*2,[{'trace_id':trace,'boundary':current}]*201):
            with self.subTest(items=len(items)),self.assertRaises(ValueError):service.execution_metadata(self.token,'w',items)

    def test_source_budget_accumulates_across_compatibility_pages(self):
        nodes=[fixture.node(),fixture.node('child','child-task',parent='root')]
        self.prepare_source(fixture.bundle(nodes));service=self.service()
        traces=[row['trace_id'] for row in self.queries.list_traces(self.token,'w')['items']];costs=[]
        for trace in traces:
            with self.control.read_transaction() as con:boundary=service._boundary(con,self.token,'w',trace)[0]
            budget={'remaining':10**9};service.execution_metadata(self.token,'w',[{'trace_id':trace,'boundary':boundary}],source_budget=budget)
            costs.append(10**9-budget['remaining'])
        original=self.queries.list_traces
        def page(token,workspace,**options):return original(token,workspace,limit=1,cursor=options.get('cursor'))
        from services.storage.trace_evidence import EvidenceTooLarge
        with patch.object(self.queries,'list_traces',page),patch('services.storage.trace_analytics.MAX_EXECUTION_SOURCE_BYTES',max(costs)+1),self.assertRaises(EvidenceTooLarge):
            self.listing().read(self.token,'w',{})

    def test_facets_use_relations_globally_and_filters_preserve_child_version_zero(self):
        root=fixture.node();root['execution'].update(skill='fallback-only',skillVersion=3,executionSkills=[])
        child=fixture.node('child','child-task',parent='root');child['execution'].update(skill='child-root',skillVersion=None,executionSkills=[{'skillName':'actual','skillVersion':0,'isPrimary':True}])
        self.prepare_source(fixture.bundle([root,child]));api=self.listing()
        self.assertEqual(api.read(self.token,'w',{'facet':'skills'}),[{'name':'actual','versions':[0]}])
        rows=api.read(self.token,'w',{'skill':'actual','skillVersion':'0','includeSubagents':'1'})
        self.assertEqual([row['task_id'] for row in rows],['child-task']);self.assertEqual(rows[0]['root_skill'],{'name':'actual','version':0})
        self.assertFalse(any(key.startswith('_') for key in rows[0]))

    def test_historical_answer_then_current_outcome_then_query_reset_precedence(self):
        from services.storage.experiments import ExperimentStore
        from services.storage.trace_outcome import patch_query
        from services.storage.tests import test_trace_outcome as outcome_fixture
        node=fixture.node();node['execution'].update(skill='root',skillVersion=None,answerScore=0.75,isAnswerCorrect=True,judgmentReason='historical',skillScore=0,skillTriggerRate=0)
        trace=self.prepare_source(fixture.bundle([node]));api=self.listing()
        self.assertEqual(api.read(self.token,'w',{})[0]['answer_score'],0.75)
        store=ExperimentStore(self.control,evidence=TraceEvidence(self.queries,self.authorized),frozen_assets_verifier=lambda *_:True)
        run=outcome_fixture.OutcomeTests.begin(self,store);outcome_fixture.OutcomeTests.finish(self,store,run)
        row=api.read(self.token,'w',{})[0];self.assertEqual(row['answer_score'],0);self.assertFalse(row['is_answer_correct']);self.assertEqual(row['skill_score'],0)
        with self.control.transaction() as con:patch_query(store,con,self.token,'w',trace,'new question')
        row=api.read(self.token,'w',{})[0];self.assertIsNone(row['answer_score']);self.assertFalse(row['is_answer_correct']);self.assertEqual(row['judgment_reason'],'结果评估中...')
        self.assertEqual(row['root_skill'],{'name':'root','version':None})

    def test_trusted_agent_recording_preserves_explicit_source_skill_version_in_trace_and_list(self):
        from services.storage.agent_traces import AgentTraceRecorder
        from services.storage.experiments import ExperimentStore
        from services.storage.tests.test_agent_traces import snapshot
        from services.storage.tests.test_experiments import experiment
        for version in (0,3,None,'missing'):
            with self.subTest(version=version):
                self.setUp();store=ExperimentStore(self.control)
                store.dispatch('create',self.token,'w',{'experiment':experiment(),'operation_key':'create'})
                store.dispatch('execute_start',self.token,'w',{'experiment_id':'exp','execution_request':{'kind':'local'},'frozen_evaluators':{'judge':{'id':'judge'}},'operation_key':'start'})
                item=store.dispatch('claim',self.token,'w',{'experiment_id':'exp','phase':'execute','worker_id':'worker'})
                body=snapshot();body['record']['skill']='fixed-skill'
                if version!='missing':body['record']['skill_version']=version
                body['context']={'experiment_recording_kind':'execution','experiment_id':'exp','experiment_attempt_id':item['attempt_id'],'experiment_fence':item['fence'],'experiment_lease_owner':item['lease_owner']}
                receipt=AgentTraceRecorder(self.control,self.ingest).record(self.token,'w',body);self.drain()
                evidence=TraceEvidence(self.queries,self.authorized).read(self.token,'w',trace_ref=receipt['trace_id'])
                expected=None if version=='missing' else version
                self.assertEqual(evidence['execution'].get('skillVersion'),expected)
                raw=self.read(receipt['trace_id'])['items'][0]['execution']
                self.assertEqual(raw.get('skillVersion'),expected)
                row=self.listing().read(self.token,'w',{})[0]
                self.assertEqual(row['skill_version'],expected);self.assertEqual(row['root_skill'],{'name':'fixed-skill','version':expected})

    def test_native_root_metadata_is_explicit_and_child_skill_is_not_a_root(self):
        from services.storage.tests.test_observations import packet
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['attributes'].extend([{'key':'legacy.skill','value':{'stringValue':'native-root'}},{'key':'legacy.skill_version','value':{'intValue':'0'}},{'key':'legacy.answer_score','value':{'doubleValue':0}}])
        self.ingest.accept(self.token,'w',body);self.drain()
        row=self.listing().read(self.token,'w',{})[0]
        self.assertEqual(row['root_skill'],{'name':'native-root','version':0});self.assertEqual(row['answer_score'],0)
        body=packet(trace='f'*32);span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0];span['parentSpanId']='a'*16
        span['attributes'].append({'key':'legacy.skill','value':{'stringValue':'child-only'}})
        self.ingest.accept(self.token,'w',body);self.drain()
        rows=self.listing().read(self.token,'w',{});self.assertEqual(sum(row['root_skill'] is None for row in rows),1)

    def test_current_outcome_invocations_drive_the_same_skill_filter_and_facet(self):
        node=fixture.node();node['execution'].update(skill='old',skillVersion=1,executionSkills=[{'skillName':'old','skillVersion':1,'isPrimary':True}])
        self.prepare_source(fixture.bundle([node]));api=self.listing()
        selected={'run_id':'run','is_evaluating':False,'selection_hash':'fixed','outcome':{'value':{
            'answer_score':0,'is_answer_correct':False,'judgment_reason':'result','failures':[],'skill_issues':[],
            'record_projection':{'skill':'current','skill_version':0,'skills':['current'],'invokedSkills':[{'name':'current','version':0}]}}}}
        with patch('services.storage.trace_outcome._lookup_tx',return_value=selected):
            self.assertEqual(api.read(self.token,'w',{'facet':'skills'}),[{'name':'current','versions':[0]}])
            rows=api.read(self.token,'w',{'skill':'current','skillVersion':'0'})
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]['root_skill'],{'name':'current','version':0})
            self.assertEqual(api.read(self.token,'w',{'skill':'old'}),[])

    def test_metadata_revocation_during_source_read_returns_no_partial_page(self):
        from services.storage.dataset_generation_sources import GenerationSources
        from services.storage.iam import Unauthorized
        trace=self.prepare_source();original=GenerationSources._metadata
        def revoke(reader,*args):
            result=original(reader,*args);self.iam.revoke_credential(self.token);return result
        with patch.object(GenerationSources,'_metadata',revoke),self.assertRaises(Unauthorized):self.read(trace)

    def test_original_defaults_do_not_erase_already_captured_summary_collections(self):
        from services.storage.execution_metadata import record_fields
        record={'skills':['captured'],'invoked_skills':[{'name':'captured','version':None}],'is_subagent':True}
        record.update(record_fields({'isSkillCorrect':None,'skillIssues':None}))
        self.assertEqual(record['skills'],['captured']);self.assertEqual(record['invoked_skills'],[{'name':'captured','version':None}])
        self.assertTrue(record['is_subagent']);self.assertFalse(record['is_skill_correct']);self.assertEqual(record['skill_issues'],[])
        self.assertNotIn('failures',record);self.assertNotIn('answer_score',record)

    def test_admin_listing_excludes_member_private_judge_before_source_metadata(self):
        analytics_fixture.AnalyticsGroupAuthorizationTests.setUp(self)
        admin=self.admin
        root=fixture.node();child=fixture.node('judge','judge-task',parent='root')
        trace=self.prepare_source(fixture.bundle([root,child]));judge=self.metadata.resolve(self.token,'w','judge','execution')['trace_id']
        from services.storage.experiments import ExperimentStore
        from services.storage.tests.test_experiments import experiment,ExperimentTests
        store=ExperimentStore(self.control)
        store.dispatch('create',self.token,'w',{'experiment':experiment(),'operation_key':'create'})
        store.dispatch('start',self.token,'w',{'experiment_id':'exp','operation_key':'start','frozen_evaluators':{'judge':{'id':'judge'}}})
        handle=store.dispatch('claim',self.token,'w',{'experiment_id':'exp','worker_id':'worker'})
        with self.control.transaction() as con:store.register_judge_trace_tx(con,self.token,'w',ExperimentTests.handle(handle),judge)
        self.assertEqual([row['trace_id'] for row in self.queries.list_traces(admin,'w')['items']],[trace])
        rows=self.listing().read(admin,'w',{'includeSubagents':'1'})
        self.assertEqual([row['task_id'] for row in rows],['task'])

    def test_encoded_null_historical_json_keeps_original_null_instead_of_rejecting_trace(self):
        node=fixture.node();node['execution'].update(failures='null',skillIssues='null')
        self.prepare_source(fixture.bundle([node]));row=self.listing().read(self.token,'w',{})[0]
        self.assertIn('failures',row);self.assertIsNone(row['failures']);self.assertFalse(row['has_failures'])
        self.assertIsNone(row['skill_issues'])

    def test_encoded_null_skill_collections_remain_absent_without_accepting_invalid_collections(self):
        from services.storage.execution_metadata import select_execution,record_fields
        from services.storage.trace_evidence import EvidenceUnavailable
        for key in ('skills','invokedSkills','executionSkills','failures','skillIssues'):
            with self.subTest(key=key):
                selected=select_execution({key:'null','skill':'root','skillVersion':0})
                record=record_fields(selected)
                self.assertEqual(record['root_skill'],{'name':'root','version':0})
                if key in ('skills','invokedSkills','executionSkills'):
                    self.assertNotIn('skills',record);self.assertIsNone(record['_execution_relations'])
                for invalid in ('{}','1','true','"text"',{},1,False):
                    with self.subTest(invalid=invalid),self.assertRaises(EvidenceUnavailable):select_execution({key:invalid})
