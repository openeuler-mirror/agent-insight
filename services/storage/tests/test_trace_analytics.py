import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_trace_transfer as fixture


class AnalyticsFacts(fixture.MemoryFacts):
    def __init__(self):
        super().__init__();self.analytics={};self.ras={};self.before_analytics_read=None

    def write_analytics(self,row):
        key=tuple(row[k] for k in ('workspace_id','trace_id','boundary','parser_version','projection_hash'))
        self.analytics[key]=copy.deepcopy(row)

    def read_analytics(self,workspace,selections):
        rows=[]
        for selection in selections:
            key=(workspace,selection['trace_id'],selection['boundary'],1,selection['projection_hash'])
            if key in self.analytics:rows.append(copy.deepcopy(self.analytics[key]))
        if self.before_analytics_read:self.before_analytics_read()
        return rows

    def write_ras_event(self,row):
        self.ras[tuple(row[k] for k in ('workspace_id','owner_principal_id','task_id','event_key','content_hash'))]=copy.deepcopy(row)

    def read_ras_events(self,workspace,selections):
        return [copy.deepcopy(self.ras[tuple(row[k] for k in ('workspace_id','owner_principal_id','task_id','event_key','content_hash'))]) for row in selections]


class TraceAnalyticsTests(unittest.TestCase):
    drain=fixture.TraceTransferTests.drain

    def make_control(self):return fixture.SQLiteControlStore(Path(self.tmp.name)/'db',clock=lambda:self.now)

    def setUp(self):
        from services.storage.trace_transfer import LegacyTraceTransfer
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.now=1794441600000
        self.control=self.make_control();self.control.initialize();self.iam=fixture.IAMStore(self.control)
        for name in ('alice','bob'):self.iam.create_principal(name,name,name)
        self.control.create_workspace('w','W');self.iam.bind_workspace('w',principal_id='alice')
        self.token=self.iam.issue_session_for_provisioning('alice');self.bob=self.iam.issue_session_for_provisioning('bob')
        self.facts=AnalyticsFacts();self.ingest=fixture.ObservationIngest(self.control,self.facts);self.metadata=fixture.TraceMetadata(self.control)
        self.queries=fixture.TraceQueries(self.control,self.facts,cursor_secret=b'private-transfer-test-cursor-secret')
        self.authorized=fixture.AuthorizedStorage(self.iam,self.facts)
        self.transfer=LegacyTraceTransfer(self.control,self.queries,self.authorized,self.metadata,self.ingest)

    def service(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.trace_analytics'),'authorized analytics projection is required')
        from services.storage.trace_analytics import TraceAnalytics
        return TraceAnalytics(self.queries,self.authorized)

    def prepare_source(self,source=None):
        facts=AnalyticsFacts();self.facts=facts;self.ingest.facts=facts;self.queries.facts=facts;self.authorized.facts=facts
        result=self.transfer.import_bundle(self.token,'w',source or fixture.bundle());self.drain()
        return self.metadata.resolve(self.token,'w',result['rootExecutionId'],'execution')['trace_id']

    @staticmethod
    def projection(prepared):
        execution=prepared['evidence']['execution']
        return {'version':1,'executions':[{'id':execution['id'],'taskId':execution['taskId'],'user':execution['user'],
            'latency':0,'cost':0,'isAnswerCorrect':False,'failures':None,'callStats':None}],
            'collaboration':{'candidate':False,'startTime':None,'edges':[]},'errors':[],
            'provenance':{'snapshot_hash':prepared['evidence']['snapshot_hash']}}

    def publish(self,trace):
        service=self.service();prepared=service.prepare(self.token,'w',trace)
        projection=self.projection(prepared)
        receipt=service.publish(self.token,'w',trace,prepared['boundary'],projection)
        return service,prepared,projection,receipt

    def test_pending_is_explicit_and_ready_read_never_reads_evidence(self):
        trace=self.prepare_source();service=self.service()
        page=service.read(self.token,'w')
        self.assertEqual(page['items'],[]);self.assertEqual([p['trace_id'] for p in page['pending']],[trace])
        service,prepared,projection,receipt=self.publish(trace)
        from services.storage.trace_evidence import TraceEvidence
        with (patch.object(TraceEvidence,'read',side_effect=AssertionError('statistics read loaded full Trace')),
             patch.object(self.authorized,'read_payload',side_effect=AssertionError('statistics read loaded body'))):
            page=service.read(self.token,'w')
        self.assertEqual(page['pending'],[]);self.assertEqual(page['items'][0]['projection'],projection)
        self.assertEqual(page['items'][0]['boundary'],prepared['boundary'])
        self.assertEqual(page['items'][0]['projection']['executions'][0]['cost'],0)
        self.assertFalse(page['items'][0]['projection']['executions'][0]['isAnswerCorrect'])
        self.assertEqual(service.publish(self.token,'w',trace,prepared['boundary'],projection),receipt)

    def test_stale_publication_and_stale_cache_are_rejected_after_annotation(self):
        trace=self.prepare_source();service,prepared,projection,_=self.publish(trace)
        self.metadata.patch(self.token,'w',trace,{'label':'new label'})
        with self.assertRaises(Conflict):service.publish(self.token,'w',trace,prepared['boundary'],projection)
        page=service.read(self.token,'w');self.assertEqual(page['items'],[])
        self.assertEqual([row['trace_id'] for row in page['pending']],[trace])

    def test_other_owner_and_retired_trace_cannot_prepare_or_publish(self):
        trace=self.prepare_source();service,prepared,projection,_=self.publish(trace)
        for action in (lambda:service.prepare(self.bob,'w',trace),lambda:service.publish(self.bob,'w',trace,prepared['boundary'],projection)):
            with self.assertRaises(Forbidden):action()
        self.metadata.delete(self.token,'w',trace)
        self.assertEqual(service.read(self.token,'w')['items'],[])
        with self.assertRaises((Forbidden,Conflict)):service.publish(self.token,'w',trace,prepared['boundary'],projection)

    def test_divergent_same_boundary_is_never_current_and_unaccepted_ch_rows_are_hidden(self):
        trace=self.prepare_source();service,prepared,projection,_=self.publish(trace)
        changed=copy.deepcopy(projection);changed['executions'][0]['cost']=999
        with self.assertRaises(Conflict):service.publish(self.token,'w',trace,prepared['boundary'],changed)
        self.assertEqual(service.read(self.token,'w')['items'][0]['projection'],projection)
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT COUNT(*) FROM trace_analytics_publications').fetchone()[0],1)

    def test_source_change_or_revocation_during_ch_read_discards_all_results(self):
        trace=self.prepare_source();service,_,_,_=self.publish(trace)
        self.facts.before_analytics_read=lambda:self.metadata.patch(self.token,'w',trace,{'query':'changed during read'})
        with self.assertRaises(Conflict):service.read(self.token,'w')
        self.facts.before_analytics_read=None
        self.publish(trace)
        self.facts.before_analytics_read=lambda:self.iam.revoke_credential(self.token)
        from services.storage.iam import Unauthorized
        with self.assertRaises(Unauthorized):service.read(self.token,'w')

    def test_invalid_payload_cannot_smuggle_interactions_or_nonfinite_metrics(self):
        trace=self.prepare_source();service=self.service();prepared=service.prepare(self.token,'w',trace)
        for change in ({'interactions':[{'content':'body'}]},{'version':2},{'executions':[{'id':'root','interactions':[]}]},{'errors':float('nan')}):
            value=self.projection(prepared)|change
            with self.subTest(change=change),self.assertRaises(ValueError):service.publish(self.token,'w',trace,prepared['boundary'],value)

    def test_source_boundary_is_stable_across_actor_credentials_and_changes_on_source_revision(self):
        trace=self.prepare_source();service=self.service()
        first=service.prepare(self.token,'w',trace)
        token=self.iam.issue_session_for_provisioning('alice')
        self.assertEqual(service.prepare(token,'w',trace)['boundary'],first['boundary'])
        with self.control.read_transaction() as con:ref=con.execute('SELECT packet_ref FROM ingest_batches ORDER BY accepted_at_ms LIMIT 1').fetchone()[0]
        packet=json.loads(self.ingest._load(ref)['json']);span=packet['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['attributes'].append({'key':'agent_insight.revision','value':{'intValue':'2'}});span['name']='updated span'
        self.ingest.accept(self.token,'w',packet);self.drain()
        with self.assertRaises(Conflict):service.publish(self.token,'w',trace,first['boundary'],self.projection(first))

    def test_ready_read_checks_one_trace_head_without_scanning_span_heads(self):
        trace=self.prepare_source();service,_,_,_=self.publish(trace)
        from contextlib import contextmanager
        original=self.control.read_transaction;queries=[]
        class Connection:
            def __init__(self,con):self.con=con
            def execute(self,sql,args=()):
                if 'FROM obs_entity_heads' in sql:queries.append(sql)
                return self.con.execute(sql,args)
        @contextmanager
        def read():
            with original() as con:yield Connection(con)
        with patch.object(self.control,'read_transaction',read):self.assertEqual(service.read(self.token,'w')['items'][0]['trace_id'],trace)
        self.assertTrue(queries);self.assertTrue(all("entity_kind='trace'" in sql and 'entity_id=?' in sql for sql in queries))

    def test_null_original_session_keeps_execution_without_fabricating_trajectory(self):
        source=fixture.bundle();source['executions'][0]['session']=None
        trace=self.prepare_source(source);prepared=self.service().prepare(self.token,'w',trace)
        self.assertEqual(prepared['evidence']['execution']['id'],'root');self.assertIsNone(prepared['evidence']['session'])

    def test_pagination_is_bounded_signed_and_has_no_duplicate_trace(self):
        source=fixture.bundle([fixture.node(),fixture.node('child','child-task','root')]);self.prepare_source(source)
        service=self.service();first=service.read(self.token,'w',limit=1)
        self.assertIsNotNone(first['next_cursor']);self.assertEqual(len(first['pending']),1)
        second=service.read(self.token,'w',limit=1,cursor=first['next_cursor'])
        self.assertIsNone(second['next_cursor']);self.assertNotEqual(first['pending'][0]['trace_id'],second['pending'][0]['trace_id'])
        for limit in (0,201):
            with self.assertRaises(ValueError):service.read(self.token,'w',limit=limit)
        from services.storage.trace_service import CursorExpired
        with self.assertRaises(CursorExpired):service.read(self.token,'w',cursor=first['next_cursor']+'x')

    def test_validate_rechecks_all_page_sources_without_body_reads(self):
        trace=self.prepare_source();service=self.service();page=service.read(self.token,'w')
        items=page['pending']
        result=service.dispatch('validate',self.token,'w',{'items':items})
        self.assertEqual(result['scope_fingerprint'],page['scope_fingerprint'])
        self.metadata.patch(self.token,'w',trace,{'label':'changed'})
        with self.assertRaises(Conflict):service.dispatch('validate',self.token,'w',{'items':items})

    def test_ras_real_events_update_idempotently_and_require_authorized_owner_trace(self):
        trace=self.prepare_source();service=self.service()
        empty=service.read(self.token,'w')['ras_read_token']
        self.assertEqual(service.dispatch('validate_ras',self.token,'w',{'read_tokens':[empty]})['scope_fingerprint'],self.iam.scope(self.token).fingerprint)
        event={'id':'ras-id','type':'action_result','taskId':'task','deliveryId':'delivery','framework':'opencode','platform':'opencode',
            'anomalyKind':'timeout','severity':'warn','summary':'actual timeout','actionTypes':'["retry"]','payloadJson':'{"action_result":{"ok":false}}','ts':'2026-11-12T00:00:00Z'}
        first=service.ras_ingest(self.token,'w',[event]);self.assertEqual(first,{'accepted':1,'ids':['ras-id']})
        with self.assertRaises(Conflict):service.dispatch('validate_ras',self.token,'w',{'read_tokens':[empty]})
        self.assertEqual(service.ras_ingest(self.token,'w',[event]),first)
        self.assertEqual(service.read(self.token,'w')['ras_events'][0]['summary'],'actual timeout')
        read_token=service.read(self.token,'w')['ras_read_token']
        with patch.object(self.facts,'read_ras_events',side_effect=AssertionError('validation read RAS fact body')):
            self.assertEqual(service.dispatch('validate_ras',self.token,'w',{'read_tokens':[read_token]})['scope_fingerprint'],self.iam.scope(self.token).fingerprint)
        changed=event|{'id':'new-normalizer-id','summary':'retry completed','payloadJson':'{"action_result":{"ok":true}}'}
        service.ras_ingest(self.token,'w',[changed]);current=service.read(self.token,'w')['ras_events']
        self.assertEqual(len(current),1);self.assertEqual(current[0]['id'],'ras-id');self.assertEqual(current[0]['summary'],'retry completed')
        with self.assertRaises(Conflict):service.dispatch('validate_ras',self.token,'w',{'read_tokens':[read_token]})
        with self.control.read_transaction() as con:self.assertEqual(con.execute('SELECT revision FROM ras_event_receipts').fetchone()[0],2)
        with self.assertRaises(Forbidden):service.ras_ingest(self.bob,'w',[event])
        self.metadata.delete(self.token,'w',trace)
        self.assertEqual(service.read(self.token,'w')['ras_events'],[])

    def test_current_evaluation_enrichment_uses_selected_receipt_and_never_whole_runplan(self):
        trace=self.prepare_source();service=self.service()
        from services.storage.experiments import ExperimentStore
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.tests.test_experiments import experiment,ExperimentTests
        experiments=ExperimentStore(self.control,evidence=TraceEvidence(self.queries,self.authorized))
        value=experiment();value['evaluatorIdsJson']='["preset-agent-trace-quality"]';value['cases'][0].update(taskId='task',executionId='root')
        experiments.dispatch('create',self.token,'w',{'experiment':value,'operation_key':'create'})
        experiments.dispatch('start',self.token,'w',{'experiment_id':'exp','operation_key':'start','frozen_evaluators':{'preset-agent-trace-quality':{'id':'preset-agent-trace-quality'}}})
        handle=experiments.dispatch('claim',self.token,'w',{'experiment_id':'exp','worker_id':'worker'})
        experiments.dispatch('complete',self.token,'w',ExperimentTests.handle(handle)|{'operation_key':'done','result':{'score':0,'points':[{'label':'完整性','score':0},{'label':'工具选择','score':50},{'label':'冗余度','score':100}]}})
        with patch.object(ExperimentStore,'_plan',side_effect=AssertionError('statistics enrichment read RunPlan')):
            result=service.dispatch('enrich',self.token,'w',{'trace_ids':[trace]})
        self.assertEqual(result['pending_sources'],[]);self.assertEqual(len(result['trajectories']),1)
        self.assertEqual(result['trajectories'][0]['trajectoryScore'],0)
        self.assertEqual(json.loads(result['trajectories'][0]['dimensionScoresJson'])['completeness'],0)
        with (patch.object(ExperimentStore,'_plan',side_effect=AssertionError('validation read full RunPlan')),
              patch.object(ExperimentStore,'_load',side_effect=AssertionError('validation read artifact'))):
            self.assertEqual(service.dispatch('validate_enrichment',self.token,'w',{'read_tokens':[result['read_token']]})['scope_fingerprint'],result['scope_fingerprint'])
        experiments.dispatch('retry',self.token,'w',{'experiment_id':'exp','result_id':handle['result_id'],'operation_key':'retry'})
        self.assertEqual(service.dispatch('enrich',self.token,'w',{'trace_ids':[trace]})['trajectories'],[])
        with self.assertRaises(Conflict):service.dispatch('validate_enrichment',self.token,'w',{'read_tokens':[result['read_token']]})

    def test_diagnosis_enrichment_reads_current_saved_head_without_evidence(self):
        trace=self.prepare_source();service=self.service()
        from services.storage.trace_reports import TraceReports
        from services.storage.trace_evidence import TraceEvidence
        reports=TraceReports(self.queries,self.authorized);evidence=TraceEvidence(self.queries,self.authorized).read(self.token,'w',trace_ref=trace)
        begin=reports.begin(self.token,'w',trace,'agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='a'*64,generator='fixture')
        reports.update(self.token,'w',begin['row']['id'],1,begin['leaseToken'],status='done',payload={'rootCause':{'summary':'real cause'},'triage':{'severity':'high'},'privateBody':'not a summary'})
        with patch.object(TraceEvidence,'read',side_effect=AssertionError('diagnosis enrichment read body')):
            result=service.dispatch('enrich',self.token,'w',{'trace_ids':[trace]})
        self.assertEqual(result['diagnoses'],[{'executionId':'root','report':{'rootCause':{'summary':'real cause'},'triage':{'severity':'high'}}}])
        reports.begin(self.token,'w',trace,'agent-debug',expected_snapshot_hash=evidence['snapshot_hash'],interactions_hash='a'*64,generator='fixture',force=True)
        self.assertEqual(service.dispatch('enrich',self.token,'w',{'trace_ids':[trace]})['diagnoses'],[])

    def test_native_analytics_preparation_uses_full_attributes_without_compact_preview_loss(self):
        from services.storage.tests.test_observations import packet
        source=packet();span=source['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        agents=['Agent '+str(index) for index in range(80)];skills=[{'name':'long-skill-'+str(index),'version':0} for index in range(80)]
        failures=[{'failure_type':'actual','description':'真实错误'*300}]
        span['attributes'].extend([{'key':'observedAgents','value':{'stringValue':json.dumps(agents)}},{'key':'invokedSkills','value':{'stringValue':json.dumps(skills)}},
            {'key':'cacheReadInputTokens','value':{'intValue':'17'}},{'key':'cacheCreationInputTokens','value':{'intValue':'0'}},{'key':'reasoningTokens','value':{'intValue':'8'}},
            {'key':'cost','value':{'doubleValue':0.25}},{'key':'failures','value':{'stringValue':json.dumps(failures)}},{'key':'parentExecutionId','value':{'stringValue':'real-parent'}}])
        trace=self.ingest.accept(self.token,'w',source)['trace_ids'][0];self.drain()
        prepared=self.service().prepare(self.token,'w',trace)['evidence']['execution']
        self.assertEqual(prepared['observedAgents'],agents);self.assertEqual(prepared['invokedSkills'],skills)
        self.assertEqual(prepared['cacheReadInputTokens'],17);self.assertEqual(prepared['cacheCreationInputTokens'],0);self.assertEqual(prepared['reasoningTokens'],8)
        self.assertEqual(prepared['cost'],0.25);self.assertEqual(json.loads(prepared['failures']),failures);self.assertEqual(prepared['parentExecutionId'],'real-parent')
        from services.storage.trace_evidence import TraceEvidence
        ordinary=TraceEvidence(self.queries,self.authorized).read(self.token,'w',trace_ref=trace)['execution']
        self.assertNotIn('cacheReadInputTokens',ordinary)

    def test_time_selection_skips_old_pending_body_but_keeps_exact_execution_time(self):
        source=fixture.bundle();source['executions'][0]['execution']['timestamp']='2020-01-01T00:00:00Z';source['executions'][0]['session']['startTime']='2020-01-01T00:00:00Z'
        trace=self.prepare_source(source);service=self.service();selection={'from_ms':1794441600000}
        page=service.dispatch('read',self.token,'w',{'selection':selection})
        self.assertEqual(page['pending'],[]);self.assertEqual(page['items'],[])
        self.assertEqual([row['trace_id'] for row in page['checked_sources']],[trace])
        other=fixture.bundle([fixture.node('new','new-task',root='new')]);other['rootExecutionId']='new';other['executions'][0]['session']['startTime']='2020-01-01T00:00:00Z'
        self.transfer.import_bundle(self.token,'w',other);self.drain()
        page=service.dispatch('read',self.token,'w',{'selection':selection})
        self.assertEqual(len(page['pending']),1)

    def test_ready_selection_uses_actual_projection_rows_and_cursor_binds_filter(self):
        source=fixture.bundle([fixture.node(),fixture.node('child','child-task','root')]);self.prepare_source(source)
        service=self.service();first=service.read(self.token,'w',limit=1)
        trace=first['pending'][0]['trace_id'];prepared=service.prepare(self.token,'w',trace);projection=self.projection(prepared)
        projection['executions'][0].update(timestamp='2026-11-12T00:00:00Z',agentName='Actual Agent')
        service.publish(self.token,'w',trace,prepared['boundary'],projection)
        page=service.dispatch('read',self.token,'w',{'selection':{'agent':'Other Agent'}})
        self.assertEqual(page['items'],[]);self.assertEqual(len(page['pending']),1)
        from services.storage.trace_service import CursorExpired
        with self.assertRaises(CursorExpired):service.dispatch('read',self.token,'w',{'cursor':first['next_cursor'],'selection':{'agent':'Other Agent'}})

    def test_background_preparation_reads_verified_source_artifacts_without_per_span_ch_payload_calls(self):
        trace=self.prepare_source();service=self.service()
        with patch.object(self.authorized,'read_payload',side_effect=AssertionError('per-Span CH payload call')):
            evidence=service.prepare(self.token,'w',trace)['evidence']
        self.assertEqual(evidence['session']['interactions'][0]['content'],'answer')
        self.assertEqual(evidence['manifest']['evidence_source'],'prepared-source-artifacts')

    def test_conflicting_root_metrics_fail_explicitly_and_child_cache_is_not_a_trace_total(self):
        from services.storage.tests.test_observations import packet
        source=packet();spans=source['resourceSpans'][0]['scopeSpans'][0]['spans'];second=copy.deepcopy(spans[0]);second['spanId']='2'*16
        spans[0]['attributes'].append({'key':'cost','value':{'doubleValue':0.1}});second['attributes'].append({'key':'cost','value':{'doubleValue':0.2}});spans.append(second)
        trace=self.ingest.accept(self.token,'w',source)['trace_ids'][0];self.drain()
        from services.storage.trace_evidence import EvidenceUnavailable
        with self.assertRaises(EvidenceUnavailable):self.service().prepare(self.token,'w',trace)
        source=packet(trace='b'*32);spans=source['resourceSpans'][0]['scopeSpans'][0]['spans'];child=copy.deepcopy(spans[0]);child['spanId']='3'*16;child['parentSpanId']=spans[0]['spanId'];child['attributes'].append({'key':'cacheReadInputTokens','value':{'intValue':'7'}});spans.append(child)
        trace=self.ingest.accept(self.token,'w',source)['trace_ids'][0];self.drain()
        self.assertNotIn('cacheReadInputTokens',self.service().prepare(self.token,'w',trace)['evidence']['execution'])

    def test_selected_quality_receipt_supports_existing_json_column_envelopes(self):
        service=self.service();row={'evaluator_id':'preset-agent-trace-quality','source':{'execution_id':'root'}}
        ordinary=service._trajectory(row,{'score':0,'pointsJson':'[{"label":"完整性","score":0},{"label":"工具选择","score":50}]'})
        self.assertEqual(json.loads(ordinary['dimensionScoresJson']),{'completeness':0,'toolChoice':0.5})
        row['evaluator_id']='__direct_trajectory__:preset-agent-trace-quality'
        direct=service._trajectory(row,{'evidenceJson':json.dumps({'json':{'directTrajectory':{'trajectoryScore':0,'dimensionScoresJson':'{"toolChoice":0}'}}})})
        self.assertEqual(direct['trajectoryScore'],0)

    def test_flow_attribution_and_issues_require_the_exact_current_match_receipt(self):
        trace=self.prepare_source();service=self.service()
        from services.storage.experiments import ExperimentStore
        from services.storage.trace_evidence import TraceEvidence
        evidence=TraceEvidence(self.queries,self.authorized).read(self.token,'w',trace_ref=trace)
        store=ExperimentStore(self.control,evidence=TraceEvidence(self.queries,self.authorized),frozen_assets_verifier=lambda *_:True)
        manifest={'version':1,'mode':'compare','request_key':'request','trace_id':trace,'trace_snapshot_hash':evidence['snapshot_hash'],'model_selection':None,'skill':{'id':'skill','name':'checking','version':1,'content':'# frozen'},'parsed_flow':None}
        value={'id':'flow','name':'Flow','type':'single','scope':'trace-flow-analysis','evaluatorIdsJson':'["__trace_flow_match__","__trace_flow_attribution__"]','configSnapshotJson':json.dumps({'coreFlowAnalysis':manifest}),'cases':[{'id':'flow-case','executionId':'root','taskId':'task','input':'','actualOutput':''}]}
        def invoke(action,**body):return store.dispatch(action,self.token,'w',body)
        def proof(item):return {key:item[key] for key in ('attempt_id','fence','lease_owner')}|{'experiment_id':'flow'}
        invoke('create',experiment=value,operation_key='create')
        config={'core_flow_analysis':manifest,'model_selection':None,'derived_skill_ids':['skill'],'derived_skill_versions':{'skill':[1]}}
        frozen={key:{'card':{'id':key},'origin':'internal'} for key in ('__trace_flow_match__','__trace_flow_attribution__')}
        invoke('start',experiment_id='flow',evaluator_ids=['__trace_flow_match__'],config=config,frozen_evaluators=frozen,operation_key='match-start')
        item=invoke('claim',experiment_id='flow',worker_id='match')
        invoke('complete',**proof(item),result={'score':None,'evidence':{'json':{'coreFlowMatch':{'version':1,'mode':'compare','matchJson':'{}','interactionCount':1}}}},operation_key='match-done')
        match=invoke('flow_lookup',trace_ref=trace)['match'];parent={key:match[key] for key in ('machine_result_id','content_hash','run_id')}
        invoke('start',experiment_id='flow',evaluator_ids=['__trace_flow_attribution__'],config=config|{'core_flow_match_source':parent},frozen_evaluators=frozen,operation_key='attribution-start')
        item=invoke('claim',experiment_id='flow',worker_id='attribution')
        evaluation={'id':'evaluation','type':'dynamic','skillId':'skill','version':1,'executionId':'root','status':'ok'}
        issue={'id':'issue','evaluationId':'evaluation','skillId':'skill','version':1,'source':'dynamic','summary':'real issue'}
        invoke('complete',**proof(item),result={'score':50,'evidence':{'json':{'coreAlignmentAttribution':{'version':1,'match_source':parent,'data':{'trajectoryScore':0.5,'dimensionScoresJson':'{"toolChoice":0.5}'}},'directTrajectoryDerived':{'evaluations':[evaluation],'skillIssues':[issue]}}}},operation_key='attribution-done')
        ready=service.enrich(self.token,'w',[trace]);self.assertEqual(len(ready['trajectories']),1);self.assertEqual(len(ready['issues']),1)
        invoke('start',experiment_id='flow',evaluator_ids=['__trace_flow_match__'],config=config,frozen_evaluators=frozen,force_new_trace=True,operation_key='new-match')
        current=service.enrich(self.token,'w',[trace]);self.assertEqual(current['trajectories'],[]);self.assertEqual(current['issues'],[])
        with self.assertRaises(Conflict):service.validate_enrichment(self.token,'w',[ready['read_token']])


class AnalyticsMigrationTests(unittest.TestCase):
    make_control=TraceAnalyticsTests.make_control
    prepare_source=TraceAnalyticsTests.prepare_source
    drain=TraceAnalyticsTests.drain
    service=TraceAnalyticsTests.service

    def setUp(self):
        from services.storage.tests.historical_observations import pre021_ingest_fixture
        historical = pre021_ingest_fixture()
        historical.__enter__()
        self.addCleanup(historical.__exit__, None, None, None)
        from services.storage import migrations
        original=migrations.load_migrations
        with patch.object(migrations,'load_migrations',side_effect=lambda backend:original(backend)[:14]):TraceAnalyticsTests.setUp(self)

    def test_additive_014_to_015_preserves_old_rows_and_backfills_source_index_separately(self):
        from services.storage import migrations
        from services.storage.experiments import ExperimentStore
        from services.storage.trace_evidence import TraceEvidence
        from services.storage.tests.test_experiments import experiment,ExperimentTests
        trace=self.prepare_source();experiments=ExperimentStore(self.control,evidence=TraceEvidence(self.queries,self.authorized))
        value=experiment();value['evaluatorIdsJson']='["preset-agent-trace-quality"]';value['cases'][0].update(taskId='task',executionId='root')
        experiments.dispatch('create',self.token,'w',{'experiment':value,'operation_key':'create'})
        started=experiments.dispatch('start',self.token,'w',{'experiment_id':'exp','operation_key':'start','frozen_evaluators':{'preset-agent-trace-quality':{'id':'preset-agent-trace-quality'}}})
        handle=experiments.dispatch('claim',self.token,'w',{'experiment_id':'exp','worker_id':'worker'})
        experiments.dispatch('complete',self.token,'w',ExperimentTests.handle(handle)|{'operation_key':'done','result':{'score':0,'points':[{'label':'完整性','score':0}]}})
        root=Path(migrations.__file__).parent/'schema';catalogs=('core','iam','project','ingest','metadata','diagnosis','report','dataset','dataset-generation','experiment','diagnosis-run','benchmark','derived-issue-resolution')
        names=sorted({table['name'] for name in catalogs for table in json.loads((root/(name+'-catalog.json')).read_text())['tables']})
        def snapshot():
            with self.control.read_transaction() as con:
                return {name:sorted(json.dumps(list(row),ensure_ascii=False,sort_keys=True,default=str) for row in con.execute('SELECT * FROM '+name+(' WHERE version<=14' if name=='schema_meta' else '')).fetchall()) for name in names}
        before=snapshot();files={path.name:__import__('hashlib').sha256(path.read_bytes()).hexdigest() for path in self.control.artifact_directory.iterdir()};backend=getattr(self.control,'backend','sqlite')
        if backend=='sqlite':
            result=self.control.migrate(backup_path=Path(self.tmp.name)/'before015.db');self.assertEqual(result['current_version'],len(migrations.load_migrations(backend)))
        else:
            with self.control.transaction() as con:migrations.apply(con,backend,clock=self.control.clock,applied=14)
        self.assertEqual(snapshot(),before)
        self.assertEqual(files,{path.name:__import__('hashlib').sha256(path.read_bytes()).hexdigest() for path in self.control.artifact_directory.iterdir()})
        with patch.object(ExperimentStore,'_plan',side_effect=AssertionError('pending enrichment loaded full RunPlan')):
            pending=self.service().enrich(self.token,'w',[trace])
        self.assertEqual(pending['pending_sources'],[{'experiment_id':'exp','run_id':started['run_id']}]);self.assertEqual(pending['trajectories'],[])
        indexed=self.service().prepare_sources(self.token,'w','exp',started['run_id']);self.assertEqual(indexed,{'indexed':1})
        self.assertEqual(self.service().prepare_sources(self.token,'w','exp',started['run_id']),indexed)
        with patch.object(ExperimentStore,'_plan',side_effect=AssertionError('ready enrichment loaded full RunPlan')):
            ready=self.service().enrich(self.token,'w',[trace])
        self.assertEqual(ready['pending_sources'],[]);self.assertEqual(ready['trajectories'][0]['trajectoryScore'],0)
        self.assertEqual(snapshot(),before)


class AnalyticsGroupAuthorizationTests(unittest.TestCase):
    make_control=TraceAnalyticsTests.make_control
    prepare_source=TraceAnalyticsTests.prepare_source
    drain=TraceAnalyticsTests.drain
    service=TraceAnalyticsTests.service
    projection=staticmethod(TraceAnalyticsTests.projection)
    publish=TraceAnalyticsTests.publish

    def setUp(self):
        from services.storage.tests.test_datasets import DatasetTests
        from services.storage.trace_transfer import LegacyTraceTransfer
        DatasetTests.setUp(self)
        self.facts=AnalyticsFacts();self.ingest=fixture.ObservationIngest(self.control,self.facts);self.metadata=fixture.TraceMetadata(self.control)
        self.queries=fixture.TraceQueries(self.control,self.facts,cursor_secret=b'private-group-analytics-cursor-secret')
        self.authorized=fixture.AuthorizedStorage(self.iam,self.facts)
        self.transfer=LegacyTraceTransfer(self.control,self.queries,self.authorized,self.metadata,self.ingest)

    def test_admin_members_share_revoke_and_cross_owner_ras_scope(self):
        trace=self.prepare_source();self.publish(trace)
        source=fixture.bundle([fixture.node('bob-root','bob-task',root='bob-root')]);source['rootExecutionId']='bob-root'
        self.transfer.import_bundle(self.bob,'w',source);self.drain();bob_trace=self.metadata.resolve(self.bob,'w','bob-root','execution')['trace_id']
        service=self.service();prepared=service.prepare(self.bob,'w',bob_trace);service.publish(self.bob,'w',bob_trace,prepared['boundary'],self.projection(prepared))
        self.assertEqual({row['trace_id'] for row in service.read(self.token,'w')['items']},{trace})
        self.assertEqual({row['trace_id'] for row in service.read(self.admin,'w')['items']},{trace,bob_trace})
        event={'id':'event','type':'anomaly','taskId':'task','deliveryId':'delivery','summary':'actual owner event','ts':'2026-11-12T00:00:00Z'}
        service.ras_ingest(self.token,'w',[event]);service.ras_ingest(self.bob,'w',[event|{'summary':'other owner same task text'}])
        self.assertEqual([row['summary'] for row in service.read(self.admin,'w')['ras_events']],['actual owner event'])
        self.iam.share_resource(self.bob,'w','trace',bob_trace,'alice')
        self.assertEqual(len(service.read(self.token,'w')['items']),2)
        self.facts.before_analytics_read=lambda:self.iam.unshare_resource(self.bob,'w','trace',bob_trace,'alice')
        with self.assertRaises(Forbidden):service.read(self.token,'w')

    def test_private_judge_trace_is_excluded_even_for_group_admin(self):
        trace=self.prepare_source();service=self.service()
        from services.storage.experiments import ExperimentStore
        from services.storage.tests.test_experiments import experiment,ExperimentTests
        experiments=ExperimentStore(self.control)
        experiments.dispatch('create',self.token,'w',{'experiment':experiment(),'operation_key':'create'})
        experiments.dispatch('start',self.token,'w',{'experiment_id':'exp','operation_key':'start','frozen_evaluators':{'judge':{'id':'judge'}}})
        handle=experiments.dispatch('claim',self.token,'w',{'experiment_id':'exp','worker_id':'worker'})
        with self.control.transaction() as con:
            experiments.register_judge_trace_tx(con,self.token,'w',ExperimentTests.handle(handle),trace)
        self.assertEqual(service.read(self.admin,'w')['pending'],[])
        with self.assertRaises(Forbidden):service.prepare(self.admin,'w',trace)


class AnalyticsHTTPTests(unittest.TestCase):
    from services.storage.tests.test_trace_service import TraceHTTPTests as Fixture
    setUp=Fixture.setUp
    request=Fixture.request

    def test_controller_actions_are_principal_workspace_body_bound_but_reads_need_no_private_proof(self):
        import hashlib,hmac
        key=Path(self.temp.name)/'analytics-controller';key.write_text('a'*64);key.chmod(0o600);self.runtime.controller_key_file=key
        path='/v1/compat/analytics?workspace_id=w'
        def proof(value):
            digest=hashlib.sha256(json.dumps(value).encode()).hexdigest()
            return hmac.new(bytes.fromhex('a'*64),'\0'.join(('trace-analytics/v1','alice','w',digest)).encode(),hashlib.sha256).hexdigest()
        from services.storage.trace_analytics import TraceAnalytics
        with patch.object(TraceAnalytics,'dispatch',return_value={'verified':True}) as dispatch:
            for action in ('prepare','publish','prepare_sources','ras_ingest'):
                value={'action':action}
                self.assertEqual(self.request(path,self.token,body=value)[0],403)
                self.assertEqual(self.request(path,self.token,body=value,headers={'x-storage-controller-proof':proof(value)})[0],200)
                self.assertEqual(self.request(path,self.token,body=value|{'forged':True},headers={'x-storage-controller-proof':proof(value)})[0],403)
            self.assertEqual(self.request(path,self.token,body={'action':'read'})[0],200)
            self.assertEqual(self.request(path,self.token,body={'action':'validate'})[0],200)
            self.assertEqual(self.request(path,self.token,body={'action':'enrich'})[0],200)
            self.assertEqual(dispatch.call_count,7)
            self.assertEqual(self.request('/v1/compat/analytics?workspace_id=other',self.token,body={'action':'read'})[0],403)
            self.assertEqual(self.request(path,body={'action':'read'})[0],401)

    def test_write_only_collector_can_ingest_ras_but_read_only_key_cannot(self):
        import hashlib,hmac
        key=Path(self.temp.name)/'ras-controller';key.write_text('b'*64);key.chmod(0o600);self.runtime.controller_key_file=key
        facts=AnalyticsFacts();self.runtime.facts=facts;self.runtime.queries.facts=facts;self.runtime.authorized.facts=facts
        value={'action':'ras_ingest','events':[{'id':'event','taskId':'before-trace','type':'anomaly','ts':'2026-11-12T00:00:00Z'}]}
        digest=hashlib.sha256(json.dumps(value).encode()).hexdigest();proof=hmac.new(bytes.fromhex('b'*64),'\0'.join(('trace-analytics/v1','alice','w',digest)).encode(),hashlib.sha256).hexdigest()
        path='/v1/compat/analytics?workspace_id=w';headers={'x-storage-controller-proof':proof}
        self.assertEqual(self.request(path,self.api,body=value,headers=headers)[0],200)
        read_only=self.iam.issue_api_credential(self.token,'w',['read'])
        self.assertEqual(self.request(path,read_only,body=value,headers=headers)[0],403)

    def test_analytics_page_budget_maps_to_413_while_transport_errors_remain_503(self):
        from services.storage.clickhouse import ClickHouseError,ClickHouseResponseTooLarge
        from services.storage.trace_analytics import TraceAnalytics
        path='/v1/compat/analytics?workspace_id=w'
        for error,status in ((ClickHouseResponseTooLarge('budget'),413),(ClickHouseError('transport'),503)):
            with patch.object(TraceAnalytics,'dispatch',side_effect=error):
                self.assertEqual(self.request(path,self.token,body={'action':'read'})[0],status)



if __name__=='__main__':unittest.main()
