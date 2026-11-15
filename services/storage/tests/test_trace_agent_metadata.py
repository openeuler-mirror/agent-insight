import json
import unittest
from unittest.mock import patch

from services.storage.control import Conflict
from services.storage.iam import Forbidden
from services.storage.tests import test_trace_analytics as analytics_fixture
from services.storage.tests import test_trace_transfer as fixture
from services.storage.trace_evidence import TraceEvidence


class TraceAgentMetadataTests(unittest.TestCase):
    setUp=analytics_fixture.TraceAnalyticsTests.setUp
    make_control=analytics_fixture.TraceAnalyticsTests.make_control
    drain=analytics_fixture.TraceAnalyticsTests.drain
    prepare_source=analytics_fixture.TraceAnalyticsTests.prepare_source
    service=analytics_fixture.TraceAnalyticsTests.service

    def read(self,trace,*,registrations=True,token=None,boundary=None):
        service=self.service()
        self.assertTrue(callable(getattr(service,'agent_metadata',None)),'bounded Agent metadata read is required')
        with self.control.read_transaction() as con:
            current=service._boundary(con,self.token,'w',trace)[0]
        return service.agent_metadata(token or self.token,'w',[{'trace_id':trace,'boundary':boundary or current,'registrations':registrations}])

    def test_real_agent_identity_and_registration_inputs_without_full_trace_reads(self):
        node=fixture.node(interactions=[{'role':'assistant','agent':'parent','content':'private-body'}, {'role':'subagent','agent':'child','subagent_name':'worker','content':'private-child'}])
        node['execution'].update(agentId='actual-registration',agentName='parent',finalResult='private-output')
        trace=self.prepare_source(fixture.bundle([node]))
        with (patch.object(TraceEvidence,'read',side_effect=AssertionError('full Evidence must not be read')),
              patch.object(self.authorized,'read_payload',side_effect=AssertionError('CH payload must not be read'))):
            value=self.read(trace)
        row=value['items'][0]
        self.assertEqual(row['executionId'],'root');self.assertEqual(row['taskId'],'task')
        self.assertEqual(row['agentId'],'actual-registration');self.assertEqual(row['user'],'alice')
        self.assertEqual(row['interactions'],[{'role':'assistant','agent':'parent'},{'role':'subagent','agent':'child','subagent_name':'worker'}])
        self.assertNotIn('private-',json.dumps(value))
        self.assertNotIn('interactions',self.read(trace,registrations=False)['items'][0])

    def test_sessionless_execution_keeps_identity_and_has_no_registration_input(self):
        node=fixture.node();node['session']=None;node['execution']['agentId']='real'
        trace=self.prepare_source(fixture.bundle([node]));row=self.read(trace)['items'][0]
        self.assertEqual(row['agentId'],'real');self.assertEqual(row['interactions'],[])

    def test_metadata_is_bound_to_current_trace_and_real_scope(self):
        trace=self.prepare_source()
        with self.assertRaises(Forbidden):self.read(trace,token=self.bob)
        row=self.read(trace)['items'][0]
        self.metadata.patch(self.token,'w',trace,{'label':'updated'})
        with self.assertRaises(Conflict):self.read(trace,boundary=row['boundary'])

    def test_batch_contract_is_bounded_and_does_not_accept_unknown_fields(self):
        trace=self.prepare_source();service=self.service()
        self.assertTrue(callable(getattr(service,'agent_metadata',None)))
        for items in [[],[{'trace_id':trace,'boundary':'a'*64,'registrations':True,'user':'bob'}],[{'trace_id':trace,'boundary':'a'*64}]*201]:
            with self.assertRaises(ValueError):service.agent_metadata(self.token,'w',items)

    def test_native_metadata_has_no_guessed_registration_id(self):
        from services.storage.tests.test_observations import packet
        body=packet();attrs=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs.append({'key':'agent.name','value':{'stringValue':'native'}})
        result=self.ingest.accept(self.token,'w',body)
        self.drain()
        page=self.service().read(self.token,'w');trace=page['pending'][0]['trace_id']
        row=self.read(trace)['items'][0]
        self.assertIsNone(row['agentId']);self.assertEqual(row['agentName'],'test-agent')

    def test_native_registration_fields_match_original_full_session_resource_precedence(self):
        from services.storage.tests.test_observations import packet
        body=packet();attrs=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes']
        attrs.extend([{'key':'agent.name','value':{'stringValue':'Span-Agent'}},{'key':'legacy.role','value':{'stringValue':'subagent'}}])
        self.ingest.accept(self.token,'w',body);self.drain()
        trace=self.service().read(self.token,'w')['pending'][0]['trace_id']
        original=TraceEvidence(self.queries,self.authorized).read(self.token,'w',trace_ref=trace)['session']['interactions']
        expected=[{key:raw[key] for key in ('role','agent','subagent_name') if isinstance(raw.get(key),str)} for raw in original]
        self.assertEqual(self.read(trace)['items'][0]['interactions'],expected)

    def test_partial_native_child_id_does_not_become_root_registration_id(self):
        from services.storage.tests.test_observations import packet
        body=packet();span=body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]
        span['parentSpanId']='f'*16
        span['attributes'].append({'key':'agent.id','value':{'stringValue':'child-registration'}})
        self.ingest.accept(self.token,'w',body);self.drain()
        trace=self.service().read(self.token,'w')['pending'][0]['trace_id']
        self.assertIsNone(self.read(trace)['items'][0]['agentId'])

    def test_native_root_registration_aliases_match_execution_view(self):
        from services.storage.tests.test_observations import packet
        for index,alias in enumerate(('legacy.agent_id','agentId')):
            with self.subTest(alias=alias):
                body=packet(trace=str(index+1)*32)
                body['resourceSpans'][0]['scopeSpans'][0]['spans'][0]['attributes'].append({'key':alias,'value':{'stringValue':'real-registration'}})
                self.ingest.accept(self.token,'w',body);self.drain()
        for item in self.service().read(self.token,'w')['pending']:
            self.assertEqual(self.read(item['trace_id'])['items'][0]['agentId'],'real-registration')

    def test_recorded_agent_messages_keep_order_and_exclude_tool_and_metadata_carriers(self):
        from services.storage.agent_traces import AgentTraceRecorder
        from services.storage.tests.test_agent_traces import snapshot
        recorder=AgentTraceRecorder(self.control,self.ingest);body=snapshot();first=recorder.record(self.token,'w',body);self.drain()
        trace=first['trace_id']
        original=TraceEvidence(self.queries,self.authorized).read(self.token,'w',trace_ref=trace)['session']['interactions']
        expected=[{key:raw[key] for key in ('role','agent','subagent_name') if isinstance(raw.get(key),str)} for raw in original]
        self.assertEqual(self.read(trace)['items'][0]['interactions'],expected)
        self.assertEqual(len(expected),2)
