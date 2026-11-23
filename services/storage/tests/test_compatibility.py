import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest

from services.storage.iam import Forbidden


def span(index,**values):
    return dict(span_id=f'{index:016x}',trace_id='trace',parent_span_id='',kind='llm',name='chat',model='model',
        started_at_ms=1000,ended_at_ms=2000,input_tokens=None,output_tokens='7',payload_revision=f'{index:064x}',attributes_json='{}') | values


class Queries:
    def __init__(self):self.calls=[];self.block=False
    def route(self,*args):
        self.calls.append('route')
        if self.block:raise Forbidden('revoked')
        return {'trace_id':'trace','trace_bucket':'2026-11-12','created_at_ms':1000}
    def summary(self,*args):
        self.calls.append('summary')
        if self.block:raise Forbidden('revoked')
        return {'trace':{'trace_id':'trace','agent_name':'agent','framework':'generic','started_at_ms':1000,'ended_at_ms':2000,
            'input_tokens':None,'output_tokens':'7','execution_status':'done','owner_principal_id':'owner','span_count':'2'}}


class Authorized:
    def __init__(self,rows):self.rows=rows;self.calls=[];self.payload_calls=[];self.before_return=None
    def read_spans(self,token,workspace,bucket,trace,**options):
        self.calls.append(dict(options));after=options.get('after_span_id','');limit=options.get('limit',200)
        if self.before_return:self.before_return()
        return [copy.deepcopy(r) for r in self.rows if r['span_id']>after][:limit]
    def read_payload(self,token,workspace,bucket,trace,span_id,revision,section,**options):
        self.payload_calls.append((span_id,revision,section,dict(options)))
        if self.before_return:self.before_return()
        texts={'input':'[{"role":"system","content":"rules"},{"role":"user","content":"question"}]','output':'answer',
            'attributes':json.dumps({'resource':{'agent.name':'individual-agent'},'span':{'legacy.role':'assistant','gen_ai.request.temperature':0.4}})}
        text=texts.get(section)
        if text is None:return {'chunks':[],'next_chunk':None,'complete':True,'available':False}
        parts=[text[i:i+20] for i in range(0,len(text),20)];after=options.get('after_chunk',-1);limit=options.get('limit',4)
        selected=parts[after+1:after+1+limit]
        chunks=[{'chunk_no':str(i),'body':body} for i,body in enumerate(selected,after+1)]
        last=after+len(chunks)
        return {'chunks':chunks,'chunk_count':len(parts),'next_chunk':last if last+1<len(parts) else None,'complete':after==-1 and len(chunks)==len(parts)}


class CompatibilityTests(unittest.TestCase):
    def api(self):
        self.assertIsNotNone(importlib.util.find_spec('services.storage.compatibility'),'legacy Trace read compatibility must exist')
        from services.storage import compatibility
        return compatibility

    def reader(self,rows=None):
        queries=Queries();authorized=Authorized(rows or [span(1),span(2)])
        return self.api().LegacyTraceReads(queries,authorized),queries,authorized

    def test_structure_reads_complete_sorted_metadata_and_no_payload(self):
        reader,queries,authorized=self.reader([span(i) for i in range(1,502)])
        result=reader.session('token','w','trace')
        self.assertEqual(result['interactionCount'],501);self.assertEqual(len(result['interactions']),501)
        self.assertEqual(authorized.payload_calls,[]);self.assertEqual(len(authorized.calls),3)
        self.assertTrue(all(call['limit']<=200 for call in authorized.calls))
        interaction=result['interactions'][0]
        self.assertEqual(interaction['role'],'assistant');self.assertEqual(interaction['trace_kind'],'llm')
        self.assertEqual(interaction['_interactionIndex'],0);self.assertTrue(interaction['_payloadDeferred'])
        self.assertEqual(len(interaction['_payloadVersion']),64);self.assertNotIn('content',interaction)
        self.assertNotIn('input',interaction['usage']);self.assertEqual(interaction['usage']['output'],7)
        self.assertNotIn('total',interaction['usage']);self.assertIsNone(result['execution']['tokens'])
        self.assertNotIn('langfuseTraceNodes',result);self.assertEqual(queries.calls[0],'route');self.assertEqual(queries.calls[-1],'route')

    def test_interaction_index_loads_only_one_span_exact_revision_and_all_chunks(self):
        reader,queries,authorized=self.reader([span(i) for i in range(1,602)])
        expected=reader.session('token','w','trace')['interactions'][250]['_payloadVersion'];authorized.calls.clear()
        result=reader.session('token','w','trace',view='interaction',index=250)
        self.assertEqual(result['index'],250);loaded=result['interaction']
        self.assertEqual(loaded['spanId'],f'{251:016x}');self.assertEqual(loaded['content'],'answer')
        self.assertEqual(loaded['requestMessages'][0],{'role':'system','content':'rules'})
        self.assertEqual(loaded['agent'],'individual-agent');self.assertEqual(loaded['temperature'],0.4)
        self.assertFalse(loaded.get('_payloadDeferred',False));self.assertEqual(loaded['_payloadVersion'],expected)
        self.assertEqual({c[0] for c in authorized.payload_calls},{f'{251:016x}'})
        self.assertEqual({c[1] for c in authorized.payload_calls},{f'{251:064x}'})
        self.assertEqual({c[2] for c in authorized.payload_calls},{'input','output','attributes'})
        self.assertTrue(all(c[3]['limit']<=4 for c in authorized.payload_calls));self.assertEqual(len(authorized.calls),4)

    def test_structure_full_and_interactions_versions_match_and_tool_is_not_extra_llm(self):
        rows=[span(1),span(2,kind='tool',tool_name='search',parent_span_id=f'{1:016x}',model='')]
        reader,_,authorized=self.reader(rows)
        structure=reader.session('token','w','trace');full=reader.session('token','w','trace',view='full')
        self.assertEqual([x['_payloadVersion'] for x in structure['interactions']],[x['_payloadVersion'] for x in full['interactions']])
        tool=full['interactions'][1];self.assertEqual(tool['role'],'tool');self.assertEqual(tool['tool_calls'][0]['function']['name'],'search')
        self.assertEqual(tool['tool_calls'][0]['output'],'answer');self.assertEqual(tool['parentSpanId'],f'{1:016x}')
        all_rows=reader.session('token','w','trace',view='interactions')['interactions']
        self.assertEqual(all_rows,full['interactions'])

    def test_existing_agent_tool_carriers_enrich_structure_without_loading_bodies(self):
        parent=span(1,attributes_json=json.dumps({'legacy.role':'assistant','legacy.interaction_section':'legacy_interaction'}))
        tool=span(201,kind='tool',tool_name='bash',parent_span_id=parent['span_id'],execution_status='done',model='',
            attributes_json=json.dumps({'legacy.transfer_kind':'carrier'}),revision='3')
        # The carrier is in a later page; single-interaction reads must use the same complete structure.
        rows=[parent]+[span(i) for i in range(2,201)]+[tool]
        reader,_,authorized=self.reader(rows)
        original=authorized.read_payload
        raw={'role':'assistant','content':'answer','tool_calls':[{'id':'actual-call-id','type':'function',
            'function':{'name':'bash','arguments':'{"command":"cat fixture"}'},'output':'complete tool result','state':'completed'}]}
        def payload(*args,**kwargs):
            if args[6]=='legacy_interaction':
                authorized.payload_calls.append((args[4],args[5],args[6],dict(kwargs)))
                return {'chunks':[{'chunk_no':0,'body':json.dumps({'format':'agent-insight.trace-item','version':1,'kind':'interaction','value':raw})}],
                    'chunk_count':1,'next_chunk':None}
            return original(*args,**kwargs)
        authorized.read_payload=payload
        structure=reader.session('token','w','trace')
        self.assertEqual(authorized.payload_calls,[])
        self.assertEqual(structure['interactionCount'],200)
        item=structure['interactions'][0];self.assertIn('tool_calls',item);call=item['tool_calls'][0]
        self.assertEqual(call['function'],{'name':'bash'});self.assertEqual(call['state'],'success')
        self.assertNotIn('output',call);self.assertNotIn('arguments',call['function']);self.assertTrue(item['_payloadDeferred'])
        loaded=reader.session('token','w','trace',view='interaction',index=0)['interaction']
        self.assertEqual(loaded['_payloadVersion'],item['_payloadVersion']);self.assertEqual(loaded['tool_calls'],raw['tool_calls'])
        self.assertEqual({c[0] for c in authorized.payload_calls},{parent['span_id']})
        old=item['_payloadVersion'];authorized.rows[-1]['revision']='4';authorized.rows[-1]['payload_revision']='f'*64
        changed=reader.session('token','w','trace')['interactions'][0]
        self.assertNotEqual(changed['_payloadVersion'],old)
        full=reader.session('token','w','trace',view='full')['interactions'][0]
        self.assertEqual(full['_payloadVersion'],changed['_payloadVersion']);self.assertEqual(full['tool_calls'],raw['tool_calls'])

    def test_carrier_tool_structure_is_bounded_ordered_and_not_extra_interactions(self):
        from unittest.mock import patch
        parent=span(2)
        rows=[span(1,kind='tool',tool_name='first',parent_span_id=parent['span_id'],execution_status='failed',revision='1',
            attributes_json=json.dumps({'legacy.transfer_kind':'carrier'})),parent,
            span(3,kind='tool',tool_name='second',parent_span_id=parent['span_id'],execution_status='running',revision='1',
                attributes_json=json.dumps({'legacy.transfer_kind':'carrier'})),
            span(4,kind='tool',tool_name='orphan',parent_span_id='missing',attributes_json=json.dumps({'legacy.transfer_kind':'carrier'}))]
        reader,_,authorized=self.reader(rows)
        result=reader.session('token','w','trace');self.assertEqual(result['interactionCount'],1)
        calls=result['interactions'][0]['tool_calls']
        self.assertEqual([call['function']['name'] for call in calls],['first','second'])
        self.assertEqual(calls[0]['state'],'error');self.assertNotIn('state',calls[1])
        self.assertEqual(authorized.payload_calls,[])
        with patch.object(self.api(),'MAX_STRUCTURE_BYTES',600),self.assertRaises(self.api().CompatibilityLimitError):
            reader.session('token','w','trace')

    def test_compact_provider_calls_override_carrier_fallback_and_keep_task_skill_links(self):
        calls=[{'id':'task-original','function':{'name':'task','arguments':'{"subagent_type":"research","session_id":"child"}'},'output':{'session_id':'child'},'trace_split_parallel_task':True},
               {'id':'skill-original','function':{'name':'skill','arguments':'{"name":"skill-name","version":2}'}}]
        parent=span(1,attributes_json=json.dumps({'legacy.tool_calls':calls}))
        carrier=span(2,kind='tool',tool_name='task',parent_span_id=parent['span_id'],attributes_json=json.dumps({'legacy.transfer_kind':'carrier'}))
        reader,_,authorized=self.reader([parent,carrier]);result=reader.session('token','w','trace')
        self.assertEqual(result['interactions'][0]['tool_calls'],calls);self.assertEqual(authorized.payload_calls,[])

    def test_oversized_compact_tool_marker_refuses_structure_but_complete_view_still_works(self):
        row=span(1,attributes_json=json.dumps({'legacy.tool_structure_oversized':True}))
        reader,_,_=self.reader([row])
        with self.assertRaises(self.api().CompatibilityLimitError):reader.session('token','w','trace')
        self.assertEqual(reader.session('token','w','trace',view='full')['interactions'][0]['content'],'answer')

    def test_carrier_compact_call_preserves_provider_identity_and_task_link(self):
        call={'id':'provider-call','function':{'name':'task','arguments':'{"subagent_type":"research","session_id":"child"}'},'output':{'session_id':'child'}}
        carrier=span(2,kind='tool',tool_name='task',parent_span_id=span(1)['span_id'],
            attributes_json=json.dumps({'legacy.transfer_kind':'carrier','legacy.tool_call':call}))
        reader,_,authorized=self.reader([span(1),carrier]);result=reader.session('token','w','trace')
        self.assertEqual(result['interactions'][0]['tool_calls'],[call]);self.assertEqual(authorized.payload_calls,[])

    def test_invalid_index_or_view_rejected_without_payload(self):
        reader,_,authorized=self.reader()
        for index in [None,-1,True,'1',2,100000]:
            with self.subTest(index=index),self.assertRaises(self.api().InvalidInteractionIndex):reader.session('token','w','trace',view='interaction',index=index)
        with self.assertRaises(ValueError):reader.session('token','w','trace',view='unknown')
        self.assertEqual(authorized.payload_calls,[])

    def test_postflight_revocation_discards_complete_structure_and_payload(self):
        reader,queries,authorized=self.reader()
        authorized.before_return=lambda:setattr(queries,'block',True)
        with self.assertRaises(Forbidden):reader.session('token','w','trace')
        reader,queries,authorized=self.reader()
        original=authorized.read_payload
        def revoked(*args,**kwargs):
            result=original(*args,**kwargs);queries.block=True;return result
        authorized.read_payload=revoked
        with self.assertRaises(Forbidden):reader.session('token','w','trace',view='interaction',index=0)

    def test_structure_limits_fail_explicitly_instead_of_truncating(self):
        from unittest.mock import patch
        api=self.api();reader,_,_=self.reader([span(i) for i in range(1,5)])
        with patch.object(api,'MAX_STRUCTURE_SPANS',3),self.assertRaises(api.CompatibilityLimitError):reader.session('token','w','trace')
        with patch.object(api,'MAX_STRUCTURE_BYTES',128),self.assertRaises(api.CompatibilityLimitError):reader.session('token','w','trace')

    def test_pagination_corruption_cannot_loop_or_duplicate_interaction_indices(self):
        reader,_,authorized=self.reader()
        authorized.read_spans=lambda *args,**kwargs:[span(1)]*200
        with self.assertRaises(ValueError):reader.session('token','w','trace')

    def test_original_interaction_attributes_are_preserved_without_invented_metrics(self):
        reader,_,authorized=self.reader([span(1,attributes_json=json.dumps({'legacy.role':'user','agent.name':'original-agent'}))])
        original=authorized.read_payload
        def payload(*args,**kwargs):
            if args[6]=='attributes':
                text=json.dumps({'resource':{},'span':{'agent_insight.raw_interaction':{'role':'user','content':'original content','requestMessages':[{'role':'developer','content':'exact'}],'usage':{'input':5},'custom':'omitted'}}})
                return {'chunks':[{'chunk_no':0,'body':text}],'chunk_count':1,'next_chunk':None,'complete':True}
            return original(*args,**kwargs)
        authorized.read_payload=payload
        result=reader.session('token','w','trace',view='interaction',index=0)['interaction']
        self.assertEqual(result['role'],'user');self.assertEqual(result['content'],'original content');self.assertEqual(result['usage']['input'],5)
        self.assertEqual(result['requestMessages'][0]['role'],'developer');self.assertEqual(result['custom'],'omitted')
        self.assertEqual(result['usage'].get('total'),12)


    def test_payload_truncation_is_explicitly_rejected_even_if_next_cursor_is_missing(self):
        reader,_,authorized=self.reader()
        authorized.read_payload=lambda *args,**kwargs:{'chunks':[{'chunk_no':0,'body':'prefix'}],'chunk_count':2,'next_chunk':None,'complete':False}
        with self.assertRaises(ValueError):reader.session('token','w','trace',view='interaction',index=0)

    def test_full_response_budget_rejects_without_silently_truncating_body(self):
        from unittest.mock import patch
        api=self.api();reader,_,_=self.reader()
        with patch.object(api,'MAX_FULL_BYTES',128),self.assertRaises(api.CompatibilityLimitError):reader.session('token','w','trace',view='full')

    def test_full_tool_preserves_original_call_identity_and_metadata(self):
        reader,_,authorized=self.reader([span(1,kind='tool',tool_name='search')])
        original=authorized.read_payload
        def payload(*args,**kwargs):
            if args[6]=='attributes':
                text=json.dumps({'resource':{},'span':{'legacy.original_span_id':'original-call','agent_insight.raw_interaction':{'tool_calls':[{'id':'original-call','exit_code':2,'function':{'name':'original-name','arguments':'original-arguments'},'skill':{'name':'test-skill'}}]}}})
                return {'chunks':[{'chunk_no':0,'body':text}],'chunk_count':1,'next_chunk':None,'complete':True}
            return original(*args,**kwargs)
        authorized.read_payload=payload
        tool=reader.session('token','w','trace',view='interaction',index=0)['interaction']['tool_calls'][0]
        self.assertEqual(tool['id'],'original-call');self.assertEqual(tool['exit_code'],2)
        self.assertEqual(tool['function']['arguments'],'original-arguments');self.assertEqual(tool['skill']['name'],'test-skill')


    def test_structure_uses_only_real_compact_previews_and_original_session_metadata(self):
        metadata={'legacy.role':'user','agent.name':'source-agent','content_preview':'captured question','legacy.session_query':'original query','legacy.session_label':'Original label'}
        reader,_,authorized=self.reader([span(1,attributes_json=json.dumps(metadata))])
        result=reader.session('token','w','trace')
        self.assertEqual(result['query'],'original query');self.assertEqual(result['label'],'Original label')
        self.assertEqual(result['interactions'][0]['content'],'captured question');self.assertEqual(result['interactions'][0]['role'],'user')
        self.assertEqual(authorized.payload_calls,[])


    def test_original_raw_extensions_survive_while_server_pointers_remain_authoritative(self):
        reader,_,authorized=self.reader();original=authorized.read_payload
        raw={'role':'assistant','content':'exact','call_ids':['call'],'request_id':'request','response_id':'response','attempt_ids':['attempt'],
            '_collaboration':{'taskId':'source-task','index':3},'opaque':{'自定义':{'v':[1,2]}},'usage':{'input':3,'newMetric':{'v':7}},
            'spanId':'spoof','traceId':'foreign','_interactionIndex':777,'_payloadVersion':'spoof','_payloadDeferred':True,'user':'source-owner'}
        def payload(*args,**kwargs):
            if args[6]=='attributes':
                text=json.dumps({'resource':{},'span':{'agent_insight.raw_interaction':raw}})
                return {'chunks':[{'chunk_no':0,'body':text}],'chunk_count':1,'next_chunk':None,'complete':True}
            return original(*args,**kwargs)
        authorized.read_payload=payload
        interaction=reader.session('token','w','trace',view='interaction',index=0)['interaction']
        for key in ('call_ids','request_id','response_id','attempt_ids','_collaboration','opaque','user'):self.assertEqual(interaction.get(key),raw[key])
        self.assertEqual(interaction['usage']['newMetric'],raw['usage']['newMetric'])
        self.assertEqual(interaction['spanId'],f'{1:016x}');self.assertEqual(interaction['traceId'],'trace');self.assertEqual(interaction['_interactionIndex'],0)
        self.assertEqual(len(interaction['_payloadVersion']),64);self.assertFalse(interaction['_payloadDeferred'])

    def test_failed_llm_preserves_actual_error_status_and_does_not_invent_details(self):
        reader,_,authorized=self.reader([span(1,execution_status='failed',error_type='')])
        structure=reader.session('token','w','trace')['interactions'][0]
        self.assertEqual(structure.get('status'),'error');self.assertEqual(structure.get('trace_status'),'error');self.assertNotIn('error',structure)
        original=authorized.read_payload
        def payload(*args,**kwargs):
            if args[6]=='attributes':
                text=json.dumps({'resource':{},'span':{'otel.status_description':'actual upstream failure'}})
                return {'chunks':[{'chunk_no':0,'body':text}],'chunk_count':1,'next_chunk':None,'complete':True}
            return original(*args,**kwargs)
        authorized.read_payload=payload
        full=reader.session('token','w','trace',view='interaction',index=0)['interaction']
        self.assertEqual(full['error_summary'],'actual upstream failure');self.assertEqual(full['trace_kind'],'llm')


    def test_explicit_legacy_section_marker_loads_entire_body_not_structure_preview(self):
        row=span(1,attributes_json=json.dumps({'legacy.interaction_section':'legacy_interaction','content_preview':'preview'}))
        reader,_,authorized=self.reader([row]);text='完整原始正文'*400
        def payload(*args,**kwargs):
            authorized.payload_calls.append((args[4],args[5],args[6],kwargs))
            self.assertEqual(args[6],'legacy_interaction')
            capsule=json.dumps({'format':'agent-insight.trace-item','version':1,'kind':'interaction','index':0,'value':{'role':'assistant','content':text,'opaque':{'x':1}}})
            return {'chunks':[{'chunk_no':0,'body':capsule}],'chunk_count':1,'next_chunk':None,'complete':True}
        authorized.read_payload=payload
        result=reader.session('token','w','trace',view='interaction',index=0)['interaction']
        self.assertEqual(result['content'],text);self.assertFalse(result['_payloadDeferred']);self.assertEqual(result['opaque'],{'x':1})


    def test_opaque_payload_version_binds_span_identity_when_sorted_indices_shift(self):
        rows=[span(2,payload_revision='f'*64,revision='1'),span(3,payload_revision='f'*64,revision='1')]
        reader,_,authorized=self.reader(rows);structure=reader.session('token','w','trace')
        authorized.rows.insert(0,span(1,payload_revision='f'*64,revision='1'))
        loaded=reader.session('token','w','trace',view='interaction',index=1)['interaction']
        self.assertNotEqual(loaded['spanId'],structure['interactions'][1]['spanId'])
        self.assertNotEqual(loaded['_payloadVersion'],structure['interactions'][1]['_payloadVersion'])
        self.assertEqual({call[1] for call in authorized.payload_calls},{'f'*64})


@unittest.skipUnless(os.environ.get('STORAGE_COMPATIBILITY_ACCEPTANCE_ROOT'),'explicit existing isolated fixture root required')
class CompatibilityExistingClickHouseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from types import SimpleNamespace
        from services.storage.trace_service import TraceQueries
        from services.storage.authorized import AuthorizedStorage
        from services.storage.clickhouse import ClickHouseStore
        from services.storage.control import SQLiteControlStore
        from services.storage.iam import IAMStore
        from services.storage.compatibility import LegacyTraceReads
        root=Path(os.environ['STORAGE_COMPATIBILITY_ACCEPTANCE_ROOT'])
        config=json.loads((root/'core-config.json').read_text())
        if config['control']['backend']!='sqlite':raise ValueError('existing acceptance fixture must use SQLite')
        control=SQLiteControlStore(config['control']['database'])
        facts=ClickHouseStore(**config['clickhouse'])
        queries=TraceQueries(control,facts,cursor_secret=bytes.fromhex(config['cursor_secret_hex']))
        authorized=AuthorizedStorage(IAMStore(control),facts)
        cls.runtime=SimpleNamespace(queries=queries,authorized=authorized)
        cls.reader=LegacyTraceReads(queries,authorized)
        cls.access=json.loads((root/'access.json').read_text());cls.evidence=json.loads((root/'http-acceptance.json').read_text())
        cls.token=cls.access['users']['alice']['session'];cls.workspace='acceptance-main'

    def test_existing_eight_span_structure_and_exact_single_span_read_only(self):
        trace=self.evidence['normal_trace_id'];structure=self.reader.session(self.token,self.workspace,trace)
        self.assertEqual(structure['interactionCount'],8)
        interaction=self.reader.session(self.token,self.workspace,trace,view='interaction',index=0)['interaction']
        self.assertEqual(interaction['_payloadVersion'],structure['interactions'][0]['_payloadVersion'])
        self.assertEqual(interaction['spanId'],structure['interactions'][0]['spanId'])

    def test_existing_ten_thousand_span_structure_is_complete_without_payload_reads(self):
        from unittest.mock import patch
        trace=self.evidence['large_trace_id']
        with patch.object(self.runtime.authorized,'read_payload',side_effect=AssertionError('structure cannot read payload')):
            result=self.reader.session(self.token,self.workspace,trace)
        self.assertEqual(result['interactionCount'],10000)
        self.assertEqual([x['_interactionIndex'] for x in result['interactions']],list(range(10000)))
        self.assertLessEqual(len(json.dumps(result,ensure_ascii=False).encode()),16*1024*1024)
        result_single=self.reader.session(self.token,self.workspace,trace,view='interaction',index=9999)
        self.assertEqual(result_single['interaction']['_payloadVersion'],result['interactions'][9999]['_payloadVersion'])


if __name__=='__main__':unittest.main()
