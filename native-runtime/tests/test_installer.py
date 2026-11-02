import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_runtime import install


class InstallerTests(unittest.TestCase):
    def test_managed_text_preserves_unrelated_content(self):
        original = '# Original\nKeep this.\n'
        block = install.BEGIN + '\nfirst\n' + install.END
        first = install.managed_text(original, block)
        second = install.managed_text(first, block.replace('first', 'second'))
        self.assertIn('Keep this.', second)
        self.assertEqual(second.count(install.BEGIN), 1)
        with self.assertRaises(ValueError):
            install.managed_text(original + install.BEGIN, block)

    def test_install_backup_policy_wrappers_and_repeat(self):
        with tempfile.TemporaryDirectory() as folder:
            home, source = Path(folder) / 'home', Path(folder) / 'source'
            (source / 'native_runtime').mkdir(parents=True)
            (source / 'native_runtime/__init__.py').write_text('')
            (home / '.factory').mkdir(parents=True)
            (home / '.factory/AGENTS.md').write_text('Existing policy.\n')
            first = install.install(source, home, 'v1', run_tests=False)
            self.assertTrue((home / '.local/bin/team-job').is_file())
            self.assertIn('Existing policy.', (home / '.factory/AGENTS.md').read_text())
            receipt = json.loads((Path(first['backupDirectory']) / 'installation-receipt.json').read_text())
            self.assertFalse(receipt['accountCredentialsCopied'])
            second = install.install(source, home, 'v2', run_tests=False)
            self.assertEqual(second['release']['previousReleaseId'], 'v1')
            self.assertEqual((home / '.factory/AGENTS.md').read_text().count(install.BEGIN), 1)

    def test_shared_claude_instruction_symlinks_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            common = home / '.claude/CLAUDE.md'
            common.parent.mkdir()
            common.write_text('Shared original instructions.\n')
            for number in range(1, 5):
                profile = home / ('.claude-account' + str(number))
                profile.mkdir()
                (profile / 'CLAUDE.md').symlink_to(common)
            changes = install.prepare_changes(home)
            self.assertNotIn(common, changes)
            self.assertFalse(any(path.name == 'CLAUDE.md' for path in changes))
            self.assertEqual(common.read_text(), 'Shared original instructions.\n')

    def test_failed_install_restores_original_and_active_pointer(self):
        with tempfile.TemporaryDirectory() as folder:
            home, source = Path(folder) / 'home', Path(folder) / 'source'
            (source / 'native_runtime').mkdir(parents=True)
            (source / 'native_runtime/__init__.py').write_text('')
            (home / '.factory').mkdir(parents=True)
            agents = home / '.factory/AGENTS.md'
            agents.write_text('Existing policy.\n')
            original_write = install._write
            def fault(path, data, expected, mode):
                if path.name == 'team-job':
                    raise OSError('injected installation failure')
                return original_write(path, data, expected, mode)
            with patch.object(install, '_write', side_effect=fault), self.assertRaises(OSError):
                install.install(source, home, 'v1', run_tests=False)
            self.assertEqual(agents.read_text(), 'Existing policy.\n')
            self.assertFalse((home / '.factory/team-runtime/current').exists())
            self.assertFalse((home / '.factory/team-runtime/current').is_symlink())

    def test_failed_upgrade_restores_prior_pointer_and_preserves_concurrent_edit(self):
        with tempfile.TemporaryDirectory() as folder:
            home, source = Path(folder) / 'home', Path(folder) / 'source'
            (source / 'native_runtime').mkdir(parents=True)
            (source / 'native_runtime/__init__.py').write_text('')
            install.install(source, home, 'v1', run_tests=False)
            agents = home / '.factory/AGENTS.md'
            original_write = install._write
            def fault(path, data, expected, mode):
                if path.name == 'team-job':
                    agents.write_text(agents.read_text() + '\nConcurrent user edit.\n')
                    raise OSError('injected upgrade failure')
                return original_write(path, data, expected, mode)
            with patch.object(install, '_write', side_effect=fault), self.assertRaises(OSError):
                install.install(source, home, 'v2', run_tests=False)
            self.assertEqual((home / '.factory/team-runtime/current').resolve().name, 'v1')
            self.assertIn('Concurrent user edit.', agents.read_text())

    def test_final_receipt_failure_rolls_back(self):
        with tempfile.TemporaryDirectory() as folder:
            home, source = Path(folder) / 'home', Path(folder) / 'source'
            (source / 'native_runtime').mkdir(parents=True)
            (source / 'native_runtime/__init__.py').write_text('')
            original_write = install._write
            def fault(path, data, expected, mode):
                if path.name == 'installation-receipt.json' and expected is not None:
                    raise OSError('injected receipt finalization failure')
                return original_write(path, data, expected, mode)
            with patch.object(install, '_write', side_effect=fault), self.assertRaises(OSError):
                install.install(source, home, 'v1', run_tests=False)
            self.assertFalse((home / '.factory/team-runtime/current').is_symlink())
            self.assertFalse((home / '.local/bin/team-job').exists())
            prepared = next((home / '.factory/backups').glob('*/installation-receipt.json'))
            self.assertEqual(json.loads(prepared.read_text())['state'], 'prepared')


if __name__ == '__main__':
    unittest.main()
