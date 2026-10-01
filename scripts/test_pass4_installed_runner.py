"""Pure tooling checks; never invokes Docker or hashes/freezes source."""
import importlib.util
from pathlib import Path
import unittest

p = Path(__file__).with_name('pass4-installed-composition-runner.py')
spec = importlib.util.spec_from_file_location('composition_runner', p)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerContract(unittest.TestCase):
    def test_bounded_command(self):
        argv = runner.command(p.parent.parent.resolve(), 'pass4-composition-test')
        for flag in ('--network=none','--pull=never','--read-only','--cap-drop=ALL'):
            self.assertIn(flag, argv)
        self.assertIn(runner.IMAGE, argv)
        self.assertIn(runner.SUITE, argv[-1])
        self.assertNotIn('test_pass4_unmanaged_lifetime', str(argv))
        self.assertNotIn('test_owned_worker_lifetime', str(argv))
        self.assertEqual(sum(arg.startswith('type=bind,') for arg in argv), 1)
        self.assertIn('HERMES_HOME=/tmp/pass4-home', argv)
    def test_reject_ambiguous_source(self):
        with self.assertRaises(ValueError): runner.command(Path('relative'), 'test')
    def test_report_requires_exact_expected_identities(self):
        helper = p.with_name('pass4-external-offline-runner.py')
        validator_spec = importlib.util.spec_from_file_location('report_validator', helper)
        assert validator_spec is not None and validator_spec.loader is not None
        validator = importlib.util.module_from_spec(validator_spec)
        validator_spec.loader.exec_module(validator)
        expected = sorted(runner.EXPECTED_TEST_IDS)
        report = {'suite': runner.SUITE, 'complete': True, 'testsRun': 5,
                  'inventory': expected, 'executed': expected,
                  **{key: [] for key in ('failures', 'errors', 'skipped',
                                        'expectedFailures', 'unexpectedSuccesses')}}
        self.assertTrue(runner.accept_composition_report(report, 0, validator.accept_report))
        variants = {'missing': expected[:-1],
                    'substituted': expected[:-1] + [runner.SUITE + '.InstalledComposition.test_substitute'],
                    'extra': expected + [runner.SUITE + '.InstalledComposition.test_extra']}
        for label, ids in variants.items():
            with self.subTest(case=label):
                changed = dict(report, inventory=ids, executed=ids, testsRun=len(ids))
                self.assertTrue(validator.accept_report(changed, runner.SUITE, 0))
                self.assertFalse(runner.accept_composition_report(changed, 0, validator.accept_report))
            for field in ('inventory', 'executed'):
                with self.subTest(case=label, field=field):
                    changed = dict(report, **{field: ids})
                    self.assertFalse(runner.accept_composition_report(changed, 0, validator.accept_report))
        self.assertFalse(runner.accept_composition_report(report, 1, validator.accept_report))
        self.assertFalse(runner.accept_composition_report(
            dict(report, skipped=[(expected[0], 'skip')]), 0, validator.accept_report))

    def test_inventory_exactly_five_real_seam_tests(self):
        import ast
        tree = ast.parse((p.parent.parent / 'docker/hermes-staging/wolfhouse/test_pass4_installed_composition.py').read_text())
        names = [n.name for n in ast.walk(tree) if isinstance(n,ast.AsyncFunctionDef) and n.name.startswith('test_')]
        self.assertEqual(len(names),5)
        self.assertEqual({runner.SUITE + '.InstalledComposition.' + name for name in names},
                         runner.EXPECTED_TEST_IDS)
        self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr in ('skip','skipIf','skipUnless') for n in ast.walk(tree)))

if __name__ == '__main__': unittest.main()
