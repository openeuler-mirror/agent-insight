import copy
import json
import unittest
from services.storage.tests.test_collector_sources import CollectorSourceTests
from services.storage.semantic_usage import SemanticUsageStore,MODELS
from services.storage.control import Conflict,StorageError
from services.storage.iam import Forbidden

class SemanticFacts:
    def __init__(self):self.rows={};self.fail=False
    def write_semantic_fact(self,table,row):
        if self.fail:raise RuntimeError('isolated sink failure')
        self.rows[table,row['workspace_id'],row['owner_principal_id'],row['kind'],row['record_id'],row['content_hash']]=copy.deepcopy(row)
    def read_semantic_fact(self,table,ws,owner,kind,rid,digest):
        row=self.rows.get((table,ws,owner,kind,rid,digest));return json.loads(row['body_json']) if row else None
    def delete_usage_event_facts(self,ws,owner,ids):
        for key in list(self.rows):
            if key[0]=='usage_event_facts' and key[1]==ws and key[2]==owner and key[4] in ids:del self.rows[key]

class SemanticUsageTests(unittest.TestCase):
    def setUp(self):
        self.fixture=CollectorSourceTests('runTest');self.fixture.setUp();self.addCleanup(self.fixture.doCleanups);self.control=self.fixture.control;self.token=self.fixture.token;self.facts=SemanticFacts();self.store=SemanticUsageStore(self.control,self.facts)
    def source(self,rid='source',**overrides):
        return {'id':rid,'user':'legacy-alice','sourceId':'native-source','workspaceFingerprint':'workspace-hash','label':None,'collectorVersion':'test','sourceSchemaVersion':1,'firstSeenAt':'2026-11-17T00:00:00.000Z','lastSeenAt':'2026-11-17T00:00:00.000Z','lastScanCompletedAt':None,'semanticCheckpointJson':None,**overrides}
    def apply(self,operations,revision=0,domain='goal',token=None):return self.store.apply(token or self.token,'w',{'domain':domain,'revision':revision,'legacy_username':'legacy-alice','operations':operations})
    def event(self,event_id='event',**overrides):return {'eventId':event_id,'occurredAt':'2026-11-17T00:00:00.000Z','dateKey':'2026-11-17','user':'legacy-alice','featureKey':'trace','eventKey':'trace.view','source':'client','route':'/observe',**overrides}
    def test_fixed_projection_atomic_unique_scope_revision_and_owner_isolation(self):
        self.apply([{'kind':'goalPlusSource','id':'source','data':self.source()}]);self.assertEqual(self.store.read(self.token,'w','goal')['revision'],1)
        self.assertEqual(self.store.read(self.fixture.tokens['bob'],'w','goal')['rows'],[])
        with self.assertRaises(Conflict):self.apply([{'kind':'goalPlusSource','id':'source2','data':self.source('source2')}],1)
        self.assertEqual(len(self.store.read(self.token,'w','goal')['rows']),1)
        with self.assertRaises(Conflict):self.apply([{'kind':'goalPlusSource','id':'source','data':self.source(label='stale')}],0)
        with self.assertRaises(Forbidden):self.apply([{'kind':'goalPlusSource','id':'source','data':self.source(user='bob')}],1)
        with self.assertRaises(ValueError):self.apply([{'kind':'arbitrarySql','id':'x','data':{}}],1)
    def test_immutable_snapshot_reads_verified_clickhouse_and_failed_fact_rolls_back(self):
        self.apply([{'kind':'goalPlusSource','id':'source','data':self.source()}])
        snapshot={'id':'snapshot','sourceDbId':'source','snapshotId':'content-v1','kind':'goal','objectKey':'g','parentKeysJson':'{}','contentHash':'a'*64,'sourceSchemaVersion':1,'sanitizedPayloadJson':'{"exact":0}','redactionJson':'{}','observedAt':'2026-11-17T00:00:00.000Z','ingestedAt':'2026-11-17T00:00:01.000Z'}
        self.facts.fail=True
        with self.assertRaises(RuntimeError):self.apply([{'kind':'goalPlusSemanticSnapshot','id':'snapshot','data':snapshot}],1)
        self.assertEqual(self.store.read(self.token,'w','goal')['revision'],1)
        self.facts.fail=False;self.apply([{'kind':'goalPlusSemanticSnapshot','id':'snapshot','data':snapshot}],1)
        self.assertEqual(self.store.read(self.token,'w','goal')['rows'][0]['data']['sanitizedPayloadJson'],'{"exact":0}')
        with self.assertRaises(Conflict):self.apply([{'kind':'goalPlusSemanticSnapshot','id':'snapshot','data':{**snapshot,'sanitizedPayloadJson':'changed'}}],2)
        self.facts.rows.clear()
        with self.assertRaises(StorageError):self.store.read(self.token,'w','goal')
    def test_usage_in_batch_replay_cleanup_daily_preservation_and_group_scope(self):
        first=self.event();self.assertEqual(self.store.usage_persist(self.token,'w',[first,first,self.event('second')]),2)
        self.assertEqual(self.store.usage_persist(self.token,'w',[first]),0)
        daily=self.store.usage_daily(self.token,'w',to='2026-11-17');self.assertEqual(daily[0]['count'],2)
        self.assertEqual(self.store.usage_daily(self.fixture.tokens['bob'],'w',to='2026-11-17'),[])
        self.assertEqual(self.store.usage_daily(self.fixture.tokens['admin'],'w',to='2026-11-17')[0]['count'],2)
        self.assertEqual(self.store.usage_cleanup(self.token,'w','2026-11-18'),2)
        self.assertEqual(self.store.usage_persist(self.token,'w',[first]),0)
        self.assertEqual(self.store.usage_daily(self.token,'w',to='2026-11-17')[0]['count'],2)
        self.assertFalse(any(key[0]=='usage_event_facts' for key in self.facts.rows))
        self.assertEqual(self.store.usage_earliest(self.token,'w'),'2026-11-17')
    def test_usage_failure_readonly_rollback_and_fact_hash_enforcement(self):
        read=self.fixture.iam.issue_api_credential(self.fixture.token,'w',['read']);event=self.event()
        with self.assertRaises(Forbidden):self.store.usage_persist(read,'w',[event])
        self.facts.fail=True
        with self.assertRaises(RuntimeError):self.store.usage_persist(self.token,'w',[event])
        self.facts.fail=False;self.assertEqual(self.store.usage_persist(self.token,'w',[event]),1)
        for key,row in self.facts.rows.items():
            if key[0]=='usage_daily_facts':row['body_json']='{"count":999}'
        with self.assertRaises(StorageError):self.store.usage_daily(self.token,'w',to='2026-11-17')
        with self.control.read_transaction() as con:self.assertEqual(con.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_historical_raw_daily_import_is_inert_idempotent_and_never_recounts(self):
        event=self.event();daily={'dateKey':'2026-11-17','user':'legacy-alice','featureKey':'trace','eventKey':'trace.view','count':37,'firstOccurredAt':event['occurredAt'],'lastOccurredAt':event['occurredAt']}
        with self.control.transaction() as con:
            source=self.store.import_history_row(con,'w','alice','legacy-alice','GoalPlusSource',self.source())
            self.assertFalse(source['duplicate']);self.assertEqual(source['id'],'source')
            self.store.import_history_row(con,'w','alice','legacy-alice','PlatformUsageEvent',event)
            self.store.import_history_row(con,'w','alice','legacy-alice','PlatformUsageDaily',daily)
        with self.control.transaction() as con:
            self.assertTrue(self.store.import_history_row(con,'w','alice','legacy-alice','PlatformUsageDaily',daily)['duplicate'])
            self.assertTrue(self.store.import_history_row(con,'w','alice','legacy-alice','PlatformUsageEvent',event)['duplicate'])
        with self.control.transaction() as con:
            self.store.import_history_row(con,'w','alice','legacy-alice','Collaboration',{'id':'legacy-group','user':'legacy-alice','collaborationId':'legacy-group','createdAt':event['occurredAt'],'updatedAt':event['occurredAt']})
            row={'id':'legacy-event','collaborationDbId':'legacy-group','user':'legacy-alice','collaborationId':'legacy-group','eventId':'legacy-event','bodyJson':'{"original":0}','bodyHash':'original-hash','receivedAt':event['occurredAt']}
            self.store.import_history_row(con,'w','alice','legacy-alice','CollaborationEvent',row)
        imported=self.store.read(self.token,'w','collaboration')['rows'];saved=next(row['data'] for row in imported if row['kind']=='collaborationEvent');self.assertEqual(saved['eventBodyJson'],'{"original":0}');self.assertEqual(saved['contentHash'],'original-hash')
        self.assertEqual(self.store.usage_persist(self.token,'w',[event]),0)
        self.assertEqual(self.store.usage_daily(self.token,'w',to='2026-11-17')[0]['count'],37)
        self.assertEqual(self.store.usage_persist(self.token,'w',[self.event('new')]),1)
        self.assertEqual(self.store.usage_daily(self.token,'w',to='2026-11-17')[0]['count'],38)

    def test_group_admin_read_and_write_only_preparation_keep_owner_boundaries(self):
        self.apply([{'kind':'goalPlusSource','id':'source','data':self.source()}])
        rows=self.store.read(self.fixture.tokens['admin'],'w','goal',owner_username='legacy-alice')['rows'];self.assertEqual(rows[0]['id'],'source')
        self.assertEqual(self.store.read(self.fixture.tokens['bob'],'w','goal',owner_username='legacy-alice')['rows'],[])
        write=self.fixture.iam.issue_api_credential(self.fixture.token,'w',['write']);read=self.fixture.iam.issue_api_credential(self.fixture.token,'w',['read'])
        with self.assertRaises(Forbidden):self.store.read(write,'w','goal')
        self.assertEqual(self.store.read(write,'w','goal',preparation=True)['rows'][0]['id'],'source')
        with self.assertRaises(Forbidden):self.store.read(read,'w','goal',preparation=True)
