import unittest
from services.storage.tests import test_experiments as fixture

class ExperimentBackgroundTests(unittest.TestCase):
    make_control=fixture.ExperimentTests.make_control
    setUp=fixture.ExperimentTests.setUp
    service=fixture.ExperimentTests.service
    call=fixture.ExperimentTests.call
    handle=staticmethod(fixture.ExperimentTests.handle)

    def test_recovery_waits_for_live_public_preparation_lease_then_reclaims_original_plan(self):
        value=fixture.experiment();value['cases'].append(value['cases'][0]|{'id':'second'})
        self.call('create',experiment=value,operation_key='create')
        plan=self.call('execute_start',experiment_id='exp',execution_request={'workerId':'client'},frozen_evaluators={'judge':{'id':'judge'}},operation_key='start')
        first=self.call('claim',experiment_id='exp',phase='execute',case_id='case',worker_id='api')
        body={'experiment_id':'exp','run_id':first['run_id'],'phase':'execute','worker_id':'recovery','recovery_only_if_idle':True}
        self.assertIsNone(self.call('claim',**body))
        self.now+=30001;recovered=self.call('claim',**body)
        self.assertIsNotNone(recovered);self.assertEqual(recovered['run_id'],first['run_id']);self.assertEqual(recovered['plan_hash'],first['plan_hash'])

    def test_background_owned_filter_applies_before_list_budget(self):
        for token,identity,case_id in [(self.token,'alice-exp','alice-case'),(self.admin,'z-admin-exp','admin-case')]:
            value=fixture.experiment();value['id']=identity;value['cases'][0]['id']=case_id
            self.service().dispatch('create',token,'w',{'experiment':value,'operation_key':identity})
        rows=self.service().dispatch('list',self.admin,'w',{'owned_only':True,'limit':1})
        self.assertEqual([row['experiment']['id'] for row in rows],['z-admin-exp'])
