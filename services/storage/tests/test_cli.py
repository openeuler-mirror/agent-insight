import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable,'-m','services.storage',*map(str,args)],text=True,capture_output=True)

    def test_explicit_new_database_and_readonly_legacy_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            db=Path(tmp)/'new.db'
            init=self.run_cli('init-sqlite','--database',db)
            self.assertEqual(init.returncode,0,init.stderr)
            self.assertEqual(json.loads(init.stdout)['schema_version'],2)
            missing=self.run_cli('init-sqlite')
            self.assertNotEqual(missing.returncode,0)
            old=Path(tmp)/'old.db'
            con=sqlite3.connect(old);con.execute("CREATE TABLE Execution(id TEXT DEFAULT 'sensitive-secret')");con.execute("INSERT INTO Execution VALUES('x')");con.commit();con.close()
            inspect=self.run_cli('inspect-legacy','--database',old)
            self.assertEqual(inspect.returncode,0,inspect.stderr)
            self.assertEqual(json.loads(inspect.stdout)['tables'][0]['row_count'],1)
            export=self.run_cli('export-legacy','--database',old,'--output',Path(tmp)/'export')
            self.assertEqual(export.returncode,0,export.stderr)
            verify=self.run_cli('verify-export','--directory',Path(tmp)/'export')
            self.assertEqual(verify.returncode,0,verify.stderr)
            for response in (inspect,export,verify):
                self.assertNotIn('sensitive-secret',response.stdout)
            self.assertEqual(json.loads(verify.stdout)['status'],'complete')

    def test_schema_is_explicit_and_rejects_unknown_backend(self):
        ddl=self.run_cli('schema','--backend','postgresql')
        self.assertEqual(ddl.returncode,0,ddl.stderr)
        self.assertIn('CREATE TABLE asset_releases',ddl.stdout)
        self.assertNotEqual(self.run_cli('schema','--backend','mysql').returncode,0)
