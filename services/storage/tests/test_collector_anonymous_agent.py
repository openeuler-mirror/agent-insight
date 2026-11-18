import copy
import json
import unittest
from unittest.mock import patch
from services.storage.tests import test_collector_sources as fixtures
from services.storage.tests.test_observations import packet
from services.storage.observations import _normalize
from services.storage.compatibility_list import LegacyTraceList
from services.storage.trace_analytics import TraceAnalytics
from services.storage.trace_transfer import LegacyTraceTransfer


class CollectorAnonymousAgentTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.CollectorSourceTests('runTest');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        f=self.fixture;self.list=LegacyTraceList(f.queries,f.metadata,analytics=TraceAnalytics(f.queries,f.authorized));self.transfer=LegacyTraceTransfer(f.control,f.queries,f.authorized,f.metadata,f.ingest)
    def upload(self,key,agent):
        f=self.fixture;value=f.snapshot(framework='generic',rootExecutionId=None);value['execution'].update(id=key,taskId=key);value['session']['taskId']=key
        if agent is ...:value['execution'].pop('agentName')
        else:value['execution']['agentName']=agent
        receipt=f.commit(f.reserve(key,task=key,execution=key,framework='generic'),value);f.drain();return value,receipt
    def row(self,key):return self.list.read(self.fixture.token,'w',{'taskId':key})[0]
    def test_anonymous_collector_fields_match_legacy_absence_and_named_values_stay_exact(self):
        for index,agent in enumerate((...,None,'','named-agent','unknown','collector')):
            key='agent-'+str(index)
            with self.subTest(agent=str(agent)):
                value,receipt=self.upload(key,agent);row=self.row(key);summary=self.fixture.facts.summaries[('w',receipt['trace_id'])]
                self.assertEqual(summary['agent_name'],agent if isinstance(agent,str) else '')
                if agent in (...,None,''):self.assertNotIn('agent',row);self.assertNotIn('agentName',row)
                else:self.assertEqual((row['agent'],row['agentName']),(agent,agent))
                exported=self.transfer.export(self.fixture.token,'w',key)['executions'][0]['execution']
                self.assertEqual(exported.get('agentName'),value['execution'].get('agentName'))
    def test_agent_summary_keeps_named_values_and_omits_anonymous_collector_names(self):
        for index,agent in enumerate((...,None,'','named-agent','unknown','collector')):self.upload('summary-'+str(index),agent)
        self.assertEqual(self.list.read(self.fixture.token,'w',{'summary':'agents','databasePagination':'1'}),{'agents':['collector','named-agent','unknown']})
        self.assertEqual(self.list.read(self.fixture.token,'w',{'summary':'agents','taskIds':'summary-0,summary-1,summary-2'}),{'agents':[]})

    def test_old_prepared_receipt_replays_without_rewrite_then_new_snapshot_advances_consistently(self):
        f=self.fixture;value=f.snapshot(framework='generic',agentName=None,rootExecutionId=None)
        original=_normalize
        def old_collector(body,*args,**kwargs):
            body=copy.deepcopy(body)
            for resource in body['resourceSpans']:
                attributes=resource['resource']['attributes']
                if not any(item['key']=='service.name' for item in attributes):attributes.append({'key':'service.name','value':{'stringValue':'collector'}})
            return original(body,*args,**kwargs)
        with patch('services.storage.collector_sources._normalize',old_collector):
            reserved=f.reserve('old',framework='generic');accepted=f.commit(reserved,value)
        with patch.object(f.facts,'write_spans',side_effect=RuntimeError('isolated prepared write interruption')):f.ingest.work_once('old-prepared')
        self.assertEqual(f.service().status(f.api,'w',{'task_id':'task','operation_key':'old'})['state'],'prepared')
        replay=f.commit(f.reserve('old',framework='generic'),value);self.assertEqual(replay['batch_refs'],accepted['batch_refs']);f.now+=2000;f.drain()
        trace=accepted['trace_id'];old_heads=f.heads(trace);self.assertEqual(f.facts.summaries[('w',trace)]['agent_name'],'collector')
        f.commit(f.reserve('old',framework='generic'),value);f.drain();self.assertEqual(f.heads(trace),old_heads)
        next_receipt=f.commit(f.reserve('new',framework='generic'),value);f.drain();new_heads=f.heads(trace)
        self.assertEqual(next_receipt['trace_id'],trace);self.assertEqual(f.facts.summaries[('w',trace)]['agent_name'],'');self.assertNotIn('agentName',self.row('task'))
        self.assertTrue(any(new_heads[key]['source_revision']>old_heads[key]['source_revision'] for key in old_heads))
        f.commit(f.reserve('same-new',framework='generic'),value);f.drain();self.assertEqual(f.heads(trace),new_heads)
        f.commit(f.reserve('old',framework='generic'),value);f.drain();self.assertEqual(f.heads(trace),new_heads)
        self.assertIsNone(self.transfer.export(f.token,'w','execution')['executions'][0]['execution']['agentName'])
    def test_native_otlp_resource_names_and_agent_precedence_keep_existing_unknown_semantics(self):
        for service,explicit,expected in [('real-service',None,'real-service'),('collector',None,'collector'),('unknown',None,'unknown'),('',None,''),(None,None,''),('service','real-agent','real-agent')]:
            body=packet();attributes=body['resourceSpans'][0]['resource']['attributes'];attributes.clear()
            if service is not None:attributes.append({'key':'service.name','value':{'stringValue':service}})
            if explicit is not None:attributes.append({'key':'agent.name','value':{'stringValue':explicit}})
            source=_normalize(body,'w')[0];self.assertEqual(source['agent_name'],expected);self.assertEqual(source['row']['source_namespace'],'otlp')
        for index,name in enumerate((None,'real-service','unknown','collector'),1):
            body=packet(trace=f'{index:032x}');attributes=body['resourceSpans'][0]['resource']['attributes'];attributes.clear()
            if name is not None:attributes.append({'key':'service.name','value':{'stringValue':name}})
            result=self.fixture.ingest.accept(self.fixture.token,'w',body);self.fixture.drain();trace=result['trace_ids'][0]
            row=self.list.read(self.fixture.token,'w',{'executionId':trace})[0];self.assertEqual((row['agent'],row['agentName']),(name or '',name or ''))
