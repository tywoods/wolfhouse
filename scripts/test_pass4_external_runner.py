"""No Docker, freeze, hashing or extraction: pure runner gates only."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

class SourceMaterialization(unittest.TestCase):
    def test_tracked_relative_link_materializes_regular_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'AGENTS.md').write_bytes(b'authorized instructions\n')
            (source / 'CLAUDE.md').symlink_to('AGENTS.md')
            modes = runner.parse_git_modes(b'120000 ' + b'0' * 40 + b' 0\tCLAUDE.md\0')
            original = runner.source_file(source, 'CLAUDE.md', modes)
            self.assertFalse(original.is_symlink())
            self.assertEqual(original.read_bytes(), b'authorized instructions\n')
            snapshot = source / 'snapshot-copy'
            runner.shutil.copyfile(original, snapshot)
            self.assertFalse(snapshot.is_symlink())
            self.assertEqual(snapshot.read_bytes(), b'authorized instructions\n')

    def test_hostile_links_rejected(self):
        cases = ('untracked', 'wrong-mode', 'absolute', 'escaping', 'broken',
                 'cyclic', 'directory', 'untracked-chain', 'directory-ancestor')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                source = Path(directory)
                (source / 'regular').write_bytes(b'ok')
                (source / 'dir').mkdir()
                (source / 'dir' / 'file').write_bytes(b'ok')
                modes = {'link':'120000'}
                target = 'regular'
                if case == 'untracked': modes = {}
                if case == 'wrong-mode': modes = {'link':'100644'}
                if case == 'absolute': target = str(source / 'regular')
                if case == 'escaping': target = '../outside'
                if case == 'broken': target = 'missing'
                if case == 'cyclic':
                    target = 'second'
                    (source / 'second').symlink_to('link')
                    modes['second'] = '120000'
                if case == 'directory': target = 'dir'
                if case == 'untracked-chain':
                    target = 'second'
                    (source / 'second').symlink_to('regular')
                if case == 'directory-ancestor':
                    target = 'second/file'
                    (source / 'second').symlink_to('dir')
                    modes['second'] = '120000'
                (source / 'link').symlink_to(target)
                with self.assertRaises(SystemExit):
                    runner.source_file(source, 'link', modes)

    def test_unsafe_names_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ('', '.', '../file', '/file', 'a/../file', './file', 'a//file', 'file\0'):
                with self.subTest(name=name), self.assertRaises(SystemExit):
                    runner.source_file(Path(directory), name, {})

    def test_git_index_parser_preserves_names_and_rejects_unmerged(self):
        metadata = b'120000 ' + b'0' * 40
        record = metadata + b' 0\tname with\ttab\nline\0'
        self.assertEqual(runner.parse_git_modes(record), {'name with\ttab\nline':'120000'})
        for records in (record + record, metadata + b' 1\tlink\0'):
            with self.assertRaises(SystemExit): runner.parse_git_modes(records)

    def test_fresh_output_still_refuses_existing_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileExistsError): runner.fresh(Path(directory))



spec = importlib.util.spec_from_file_location('external_runner', Path(__file__).with_name('pass4-external-offline-runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerGates(unittest.TestCase):
    def test_normalized_duplicate_denied_before_extraction(self):
        with self.assertRaises(ValueError):
            runner.validate_members([tarfile.TarInfo('a.py'), tarfile.TarInfo('./a.py')])

    def test_traversal_absolute_and_nonregular_denied(self):
        for name in ('../a', '/a', 'a/../b', '.'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                runner.validate_members([tarfile.TarInfo(name)])
        member = tarfile.TarInfo('link'); member.type = tarfile.SYMTYPE
        with self.assertRaises(ValueError): runner.validate_members([member])

    def test_incomplete_results_strict_nonzero(self):
        class Fixtures(unittest.TestCase):
            def test_ok(self): pass
            @unittest.skip('fixture')
            def test_skip(self): pass
            @unittest.expectedFailure
            def test_expected(self): self.fail('fixture')
            @unittest.expectedFailure
            def test_unexpected(self): pass
            def test_failure(self): self.fail('fixture')
            def test_error(self): raise RuntimeError('fixture')
        for name in ('ok', 'skip', 'expected', 'unexpected', 'failure', 'error'):
            report = runner.execute_suite(unittest.TestSuite([Fixtures('test_' + name)]), '__main__', stream=io.StringIO())
            self.assertEqual(report['complete'], name == 'ok')
            self.assertEqual(report['testsRun'], 1)
            self.assertIn('expectedFailures', report)
            self.assertIn('unexpectedSuccesses', report)
        self.assertFalse(runner.execute_suite(unittest.TestSuite(), 'empty', stream=io.StringIO())['complete'])

    def test_inventory_and_exit_not_sufficient(self):
        report = {'suite':'fixture','testsRun':1,'inventory':['fixture.test_ok'],'executed':['fixture.test_ok'],
                  'failures':[],'errors':[],'skipped':[],'expectedFailures':[],'unexpectedSuccesses':[], 'complete':True}
        self.assertTrue(runner.accept_report(report, 'fixture', 0))
        for field, value in (('testsRun',0), ('inventory',[]), ('executed',[]), ('skipped',[['x','why']]), ('suite','wrong')):
            with self.subTest(field=field): self.assertFalse(runner.accept_report(dict(report, **{field:value}), 'fixture', 0))
        self.assertFalse(runner.accept_report(report, 'fixture', 1))

if __name__ == '__main__': unittest.main()
