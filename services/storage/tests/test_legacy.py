import base64
from contextlib import contextmanager, closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@contextmanager
def connection(path):
    with closing(sqlite3.connect(path)) as db:
        with db:
            yield db


class LegacyExportTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.find_spec('legacy')
        self.assertIsNotNone(spec, 'read-only legacy inventory/export implementation is missing')
        import legacy
        self.legacy = legacy
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / 'source.sqlite'

    def create(self, statements):
        with connection(self.source) as db:
            db.executescript(statements)

    def test_inventory_reads_rows_without_mutating_source(self):
        self.create("CREATE TABLE User(id TEXT PRIMARY KEY, username TEXT); INSERT INTO User VALUES('u1','alice');")
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        manifest = self.legacy.inventory_database(self.source)
        self.assertEqual(manifest['integrity_status'], 'ok')
        self.assertEqual(manifest['tables'][0]['row_count'], 1)
        self.assertEqual(manifest['tables'][0]['classification']['status'], 'mapped')
        self.assertNotIn('alice', json.dumps(manifest))
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), before)

    def test_live_wal_is_visible(self):
        writer = sqlite3.connect(self.source)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.executescript('CREATE TABLE Execution(id TEXT);')
        writer.execute("INSERT INTO Execution VALUES ('wal-only')")
        writer.commit()
        self.assertTrue(Path(str(self.source) + '-wal').exists())
        manifest = self.legacy.inventory_database(self.source)
        self.assertEqual(manifest['tables'][0]['row_count'], 1)

    def test_foreign_key_violations_block_export(self):
        self.create('CREATE TABLE Parent(id TEXT PRIMARY KEY); CREATE TABLE Child(parent TEXT REFERENCES Parent(id)); INSERT INTO Child VALUES (\'missing\');')
        output = self.directory / 'export'
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.export_database(self.source, output)
        self.assertFalse(output.exists())

    def test_corrupt_database_is_rejected(self):
        self.source.write_bytes(b'not a database')
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.inventory_database(self.source)

    def test_missing_source_is_not_created(self):
        with self.assertRaises(FileNotFoundError):
            self.legacy.inventory_database(self.source)
        self.assertFalse(self.source.exists())

    def test_identifiers_are_quoted_and_filename_cannot_escape(self):
        self.create('CREATE TABLE "odd\"\"/table"("a\"\"b" TEXT); INSERT INTO "odd\"\"/table" VALUES (\'text\');')
        output = self.directory / 'export'
        manifest = self.legacy.export_database(self.source, output)
        table = manifest['tables'][0]
        self.assertEqual(table['name'], 'odd"/table')
        self.assertEqual(table['columns'][0]['name'], 'a"b')
        self.assertEqual((output / table['file']).parent, output)
        self.assertEqual(table['classification']['status'], 'unclassified')

    def test_hash_is_deterministic_and_preserves_duplicate_multiplicity(self):
        self.create("CREATE TABLE data(v); INSERT INTO data VALUES ('1'),(1),(1),(NULL),(1.5),(X'0001');")
        first = self.legacy.inventory_database(self.source)
        with connection(self.source) as db:
            db.executescript('CREATE TEMP TABLE rearranged AS SELECT * FROM data ORDER BY rowid DESC; DELETE FROM data; INSERT INTO data SELECT * FROM rearranged;')
        second = self.legacy.inventory_database(self.source)
        self.assertEqual(first['source_content_sha256'], second['source_content_sha256'])
        self.assertEqual(first['tables'][0]['row_count'], 6)
        with connection(self.source) as db:
            db.execute('DELETE FROM data WHERE rowid=(SELECT MIN(rowid) FROM data WHERE typeof(v)=\'integer\')')
        third = self.legacy.inventory_database(self.source)
        self.assertNotEqual(first['source_content_sha256'], third['source_content_sha256'])

    def test_export_type_encoding_and_private_permissions(self):
        self.create("CREATE TABLE data(v); INSERT INTO data VALUES ('1'),(1),(NULL),(1.5),(X'0001');")
        output = self.directory / 'export'
        manifest = self.legacy.export_database(self.source, output)
        self.assertEqual(manifest['status'], 'complete')
        self.assertFalse((output / '.incomplete').exists())
        rows = [json.loads(line) for line in (output / manifest['tables'][0]['file']).read_text().splitlines()]
        values = [row['values'][0] for row in rows]
        self.assertIn(['integer', '1'], values)
        self.assertIn(['real', float(1.5).hex()], values)
        self.assertIn(['blob', base64.b64encode(b'\x00\x01').decode()], values)
        self.assertIn(['null', None], values)
        self.assertIn(['text', '1'], values)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
        for p in output.iterdir():
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        self.assertEqual(json.loads((output / 'manifest.json').read_text()), manifest)

    def test_existing_destination_is_never_overwritten(self):
        self.create('CREATE TABLE data(v);')
        output = self.directory / 'export'
        output.mkdir()
        marker = output / 'keep'
        marker.write_text('original')
        with self.assertRaises(FileExistsError):
            self.legacy.export_database(self.source, output)
        self.assertEqual(marker.read_text(), 'original')

    def test_failed_export_is_not_marked_complete(self):
        self.create("CREATE TABLE data(v); INSERT INTO data VALUES ('one');")
        output = self.directory / 'export'
        original = self.legacy._write_private
        def injected(path, content):
            if path.name == 'schema.json':
                raise RuntimeError('injected')
            return original(path, content)
        with patch.object(self.legacy, '_write_private', side_effect=injected):
            with self.assertRaises(RuntimeError):
                self.legacy.export_database(self.source, output)
        self.assertTrue((output / '.incomplete').exists())
        self.assertFalse((output / 'manifest.json').exists())

    def test_snapshot_does_not_mix_concurrent_commits(self):
        writer = sqlite3.connect(self.source)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.executescript("CREATE TABLE A(v); CREATE TABLE Z(v); INSERT INTO A VALUES ('before'); INSERT INTO Z VALUES ('before');")
        original = self.legacy._encode_value
        triggered = False
        def concurrent(value):
            nonlocal triggered
            if not triggered:
                triggered = True
                writer.execute("INSERT INTO Z VALUES ('after')")
                writer.commit()
            return original(value)
        with patch.object(self.legacy, '_encode_value', side_effect=concurrent):
            manifest = self.legacy.export_database(self.source, self.directory / 'export')
        self.assertTrue(triggered)
        self.assertEqual([t['row_count'] for t in manifest['tables']], [1, 1])
        self.assertEqual(writer.execute('SELECT COUNT(*) FROM Z').fetchone()[0], 2)

    def test_current_prisma_models_all_classified_and_unknown_stays_unknown(self):
        import re
        schema = Path(__file__).resolve().parents[3] / 'prisma/schema.prisma'
        models = re.findall(r'^model (\w+) \{', schema.read_text(), re.M)
        self.assertEqual(len(models), 96)
        for model in models:
            self.assertEqual(self.legacy.classify_table(model)['status'], 'mapped', model)
        self.assertEqual(self.legacy.classify_table('FutureSecretTable')['status'], 'unclassified')

    def test_real_zero_ties_have_deterministic_hashes(self):
        self.create('CREATE TABLE data(v); INSERT INTO data VALUES (-0.0),(0.0);')
        first = self.legacy.inventory_database(self.source)
        with connection(self.source) as db:
            db.executescript('DELETE FROM data; INSERT INTO data VALUES (0.0),(-0.0);')
        second = self.legacy.inventory_database(self.source)
        self.assertEqual(first['source_content_sha256'], second['source_content_sha256'])

    def make_export(self):
        self.create("CREATE TABLE data(v); INSERT INTO data VALUES ('one'),(1),(X'00');")
        output = self.directory / 'export'
        manifest = self.legacy.export_database(self.source, output)
        return output, manifest

    def test_verify_completed_export_matches_manifest(self):
        output, manifest = self.make_export()
        self.assertTrue(callable(getattr(self.legacy, 'verify_export', None)), 'verify_export is missing')
        self.assertEqual(self.legacy.verify_export(output), manifest)

    def test_verify_rejects_corruption_and_truncation(self):
        output, manifest = self.make_export()
        self.assertTrue(callable(getattr(self.legacy, 'verify_export', None)), 'verify_export is missing')
        table = output / manifest['tables'][0]['file']
        original = table.read_bytes()
        for damaged in [original[:-1], original.replace(b'one', b'two')]:
            table.write_bytes(damaged)
            with self.assertRaises(self.legacy.LegacyValidationError):
                self.legacy.verify_export(output)

    def test_verify_rejects_incomplete_and_unlisted_files(self):
        output, _ = self.make_export()
        self.assertTrue(callable(getattr(self.legacy, 'verify_export', None)), 'verify_export is missing')
        marker = output / '.incomplete'
        marker.write_text('incomplete')
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.verify_export(output)
        marker.unlink()
        (output / 'unexpected.jsonl').write_text('{}')
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.verify_export(output)

    def test_verify_rejects_manifest_when_commit_marker_removal_failed(self):
        self.create("CREATE TABLE data(v); INSERT INTO data VALUES ('one');")
        output = self.directory / 'export'
        original_unlink = Path.unlink
        def refuse_marker(path, *args, **kwargs):
            if path.name == '.incomplete':
                raise OSError('injected marker cleanup failure')
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', autospec=True, side_effect=refuse_marker):
            with self.assertRaises(OSError):
                self.legacy.export_database(self.source, output)
        self.assertTrue((output / 'manifest.json').exists())
        self.assertTrue((output / '.incomplete').exists())
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.verify_export(output)

    def test_verify_rejects_renamed_or_reordered_column_metadata(self):
        self.create("CREATE TABLE data(first TEXT NOT NULL DEFAULT 'first', second INTEGER); INSERT INTO data VALUES ('one',1);")
        output = self.directory / 'export'
        original = self.legacy.export_database(self.source, output)
        import copy
        variants = []
        renamed = copy.deepcopy(original)
        renamed['tables'][0]['columns'][0]['name'] = 'wrong_column'
        variants.append(renamed)
        reordered = copy.deepcopy(original)
        reordered['tables'][0]['columns'].reverse()
        variants.append(reordered)
        retyped = copy.deepcopy(original)
        retyped['tables'][0]['columns'][0]['declared_type'] = 'BLOB'
        variants.append(retyped)
        default_changed = copy.deepcopy(original)
        default_changed['tables'][0]['columns'][0]['default_sql'] = "'other'"
        variants.append(default_changed)
        for changed in variants:
            with self.subTest(changed=changed['tables'][0]['columns']):
                (output / 'manifest.json').write_text(json.dumps(changed))
                with self.assertRaises(self.legacy.LegacyValidationError):
                    self.legacy.verify_export(output)

    def test_verify_rejects_schema_and_manifest_mismatch(self):
        output, manifest = self.make_export()
        self.assertTrue(callable(getattr(self.legacy, 'verify_export', None)), 'verify_export is missing')
        (output / 'schema.json').write_text('[]')
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.verify_export(output)
        (output / 'schema.json').write_text(json.dumps(manifest['schema_objects']))
        manifest['tables'][0]['row_count'] += 1
        (output / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.verify_export(output)

    def test_verify_rejects_symlink_and_traversal_paths(self):
        output, manifest = self.make_export()
        self.assertTrue(callable(getattr(self.legacy, 'verify_export', None)), 'verify_export is missing')
        table = output / manifest['tables'][0]['file']
        outside = self.directory / 'outside'
        table.rename(outside)
        table.symlink_to(outside)
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.verify_export(output)
        table.unlink()
        manifest['tables'][0]['file'] = '../outside'
        (output / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(self.legacy.LegacyValidationError):
            self.legacy.verify_export(output)

    def test_verify_rejects_malformed_manifest_without_raw_exception(self):
        output, _ = self.make_export()
        self.assertTrue(callable(getattr(self.legacy, 'verify_export', None)), 'verify_export is missing')
        for value in [[], {'status': 'complete'}, {'format_version': 99}]:
            (output / 'manifest.json').write_text(json.dumps(value))
            with self.assertRaises(self.legacy.LegacyValidationError):
                self.legacy.verify_export(output)

    def test_empty_database_has_stable_manifest(self):
        sqlite3.connect(self.source).close()
        one = self.legacy.inventory_database(self.source)
        two = self.legacy.inventory_database(self.source)
        self.assertEqual(one, two)
        self.assertEqual(one['tables'], [])


if __name__ == '__main__':
    unittest.main()
