"""Portable launcher paths use local configuration without touching real accounts."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from native_runtime import auth


class AuthResolutionTests(unittest.TestCase):
    def test_all_eight_profiles_resolve_their_own_private_mapping(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            profiles = {}
            for number in range(1, 9):
                name = 'team' + str(number)
                directory = root / name
                directory.mkdir()
                profiles[name] = {'email': name + '@example.invalid', 'configDir': str(directory)}
            mapping = root / 'mapping.json'
            mapping.write_text(json.dumps({'profiles': profiles}))
            mapping.chmod(0o600)
            with patch.object(auth, 'CONFIG', mapping):
                self.assertEqual(auth.PROFILES, set(profiles))
                for name, profile in profiles.items():
                    with self.subTest(profile=name):
                        self.assertEqual(auth.profile_settings(name), (profile['email'], profile['configDir']))
                with self.assertRaises(auth.Refused):
                    auth.profile_settings('team9')

    def test_explicit_cli_path_takes_precedence_over_path_lookup(self):
        with patch.object(auth.shutil, 'which') as lookup:
            self.assertEqual(auth.resolve_cli({'NATIVE_TEAM_CLAUDE_CLI': '/configured/claude'}, '/home/fixture'),
                             '/configured/claude')
            lookup.assert_not_called()

    def test_cli_path_search_and_missing_binary_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary = root / 'bin/claude'
            binary.parent.mkdir()
            binary.write_text('#!/bin/sh\nexit 0\n')
            binary.chmod(0o700)
            self.assertEqual(auth.resolve_cli({'PATH': str(binary.parent)}, root / 'home'), str(binary))
            self.assertEqual(auth.resolve_cli({'PATH': str(root / 'missing')}, root / 'home'),
                             str(root / 'home/.local/bin/claude'))

    def test_import_uses_current_home_for_portable_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            env = dict(os.environ, HOME=str(root), PATH=str(root / 'missing'),
                       PYTHONPATH=str(Path(__file__).resolve().parents[1]), PYTHONDONTWRITEBYTECODE='1')
            for name in ('NATIVE_TEAM_CLAUDE_CLI', 'NATIVE_TEAM_PROFILE_CONFIG'):
                env.pop(name, None)
            result = subprocess.run([sys.executable, '-c',
                'import json; from native_runtime import auth; print(json.dumps([auth.CLI, str(auth.CONFIG)]))'],
                env=env, text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(result.stdout),
                             [str(root / '.local/bin/claude'),
                              str(root / '.factory/config/native-ultracode-profiles.json')])

    def test_profile_override_retains_private_file_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            profile_dir = root / 'profile'
            profile_dir.mkdir()
            mapping = root / 'mapping.json'
            mapping.write_text(json.dumps({'profiles': {'team1': {
                'email': 'fixture@example.invalid', 'configDir': str(profile_dir)}}}))
            mapping.chmod(0o600)
            configured = auth.resolve_profile_config({'NATIVE_TEAM_PROFILE_CONFIG': str(mapping)}, root)
            with patch.object(auth, 'CONFIG', configured):
                self.assertEqual(auth.profile_settings('team1'), ('fixture@example.invalid', str(profile_dir)))
                mapping.chmod(0o644)
                with self.assertRaises(auth.Refused):
                    auth.profile_settings('team1')

    def test_relative_or_empty_explicit_paths_are_rejected(self):
        for value in ('', 'relative/claude'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    auth.resolve_cli({'NATIVE_TEAM_CLAUDE_CLI': value}, '/home/fixture')
                with self.assertRaises(ValueError):
                    auth.resolve_profile_config({'NATIVE_TEAM_PROFILE_CONFIG': value}, '/home/fixture')


if __name__ == '__main__':
    unittest.main()
