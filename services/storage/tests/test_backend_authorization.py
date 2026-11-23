import json
import os
from pathlib import Path
import unittest
import uuid

from services.storage.tests import test_iam, test_authorized
from services.storage.relational import PostgreSQLControlStore, OpenGaussControlStore


class RelationalFixture:
    backend='postgresql'
    environment='STORAGE_TEST_PG_CONFIG'

    def make_store(self):
        import psycopg2
        config=json.loads(Path(os.environ[self.environment]).read_text())
        schema='iam_contract_'+uuid.uuid4().hex
        store_class=PostgreSQLControlStore if self.backend=='postgresql' else OpenGaussControlStore
        def cleanup():
            con=psycopg2.connect(config['dsn'])
            try:
                with con.cursor() as cur: cur.execute('DROP SCHEMA "'+schema+'" CASCADE')
                con.commit()
            finally: con.close()
        self.addCleanup(cleanup)
        return store_class.from_dsn(config['dsn'],schema=schema,artifact_directory=Path(self.temp.name)/'artifacts',clock=lambda:getattr(self,'now',100000))


@unittest.skipUnless(os.environ.get('STORAGE_TEST_PG_CONFIG'),'set explicit private PG configuration file')
class PostgreSQLIAMTests(RelationalFixture,test_iam.IAMTests):
    pass


@unittest.skipUnless(os.environ.get('STORAGE_TEST_PG_CONFIG'),'set explicit private PG configuration file')
class PostgreSQLAuthorizedTests(RelationalFixture,test_authorized.AuthorizedTests):
    pass


@unittest.skipUnless(os.environ.get('STORAGE_TEST_OPENGAUSS_CONFIG'),'set explicit private openGauss configuration file')
class OpenGaussIAMTests(RelationalFixture,test_iam.IAMTests):
    backend='opengauss'
    environment='STORAGE_TEST_OPENGAUSS_CONFIG'


@unittest.skipUnless(os.environ.get('STORAGE_TEST_OPENGAUSS_CONFIG'),'set explicit private openGauss configuration file')
class OpenGaussAuthorizedTests(RelationalFixture,test_authorized.AuthorizedTests):
    backend='opengauss'
    environment='STORAGE_TEST_OPENGAUSS_CONFIG'
