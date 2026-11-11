import unittest
import importlib


class ContractTests(unittest.TestCase):
    def api(self):
        try:
            return importlib.import_module('services.storage.contracts')
        except ModuleNotFoundError:
            self.fail('storage contracts must exist before enabling new storage')

    def test_manifest_hash_is_key_order_independent(self):
        c = self.api()
        self.assertEqual(c.content_hash({'b': ['中文', 3], 'a': True}), c.content_hash({'a': True, 'b': ['中文', 3]}))
        self.assertNotEqual(c.content_hash({'x': '1'}), c.content_hash({'x': 1}))

    def test_manifest_rejects_ambiguous_numbers_and_keys(self):
        c = self.api()
        for value in [{'x': float('nan')}, {'x': 1.0}, {'x': 2**53}, {3: 'value'}, {'\ud800': 1}]:
            with self.subTest(value=repr(value)):
                with self.assertRaises(ValueError):
                    c.canonical_json(value)

    def test_revision_uses_shared_signed_range(self):
        c = self.api()
        self.assertEqual(c.revision(2**63-1), 2**63-1)
        for value in [0, -1, 2**63, True, 1.0, '1']:
            with self.assertRaises(ValueError):
                c.revision(value)

    def test_identifier_rejects_empty_and_controls(self):
        c = self.api()
        self.assertEqual(c.identifier('trace:abc'), 'trace:abc')
        for value in ['', ' ', 'x\x00y', 'x\ny', 'x' * 513, None]:
            with self.assertRaises(ValueError):
                c.identifier(value)
