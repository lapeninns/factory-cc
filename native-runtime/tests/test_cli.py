import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from native_runtime import auth, cli
from native_runtime.core import RuntimeRefused


class CliTests(unittest.TestCase):
    def test_only_bounded_output_and_prompt_flags(self):
        self.assertEqual(cli.native_args(['--', '-p', '--output-format=json', 'a prompt']),
                         ['-p', '--output-format', 'json', '--', 'a prompt'])
        self.assertEqual(cli.native_args(['--', '--', '--model is literal prompt text']),
                         ['--', '--model is literal prompt text'])
        for flag in ['--model=other', '-mfoo', '-cmfoo', '--effort', '--settings',
                     '--resume', '--worktree', '--background', '--bg', '--desktop',
                     '--cloud', '--safe-mode', '--bare', '--permission-mode',
                     '--dangerously-skip-permissions', '--append-system-prompt']:
            with self.subTest(flag=flag), self.assertRaises(RuntimeRefused):
                cli.native_args([flag])
        for command in ['auth', 'update', 'stop', 'agents', 'purge']:
            with self.assertRaises(RuntimeRefused):
                cli.native_args([command])

    def test_builder_pins_identity_policy_workflow_and_session(self):
        with patch.object(auth, 'profile_settings', return_value=('one@example.invalid', '/profile')), \
             patch.object(auth, 'verify_login') as verify, \
             patch.object(auth, 'validate_configuration'), \
             patch.object(cli, 'check_cli_version', return_value={'ok': True}), \
             patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'not-exported', 'CLAUDE_CODE_SAFE_MODE': '1'}):
            build, config_dir = cli.prepare_builder('team1', ['-p', 'fixture'], 'investigate')
            job = {'worktree': '/job', 'sessionId': 'b9d47266-12c0-40a1-a534-e915bc781129'}
            argv, env = build(job)
            self.assertEqual(config_dir, '/profile')
            self.assertEqual(verify.call_count, 2)
            self.assertEqual(argv[argv.index('--permission-mode') + 1], 'manual')
            self.assertEqual(argv[argv.index('--session-id') + 1], job['sessionId'])
            self.assertEqual(argv[argv.index('--model') + 1], 'claude-opus-5-5')
            self.assertEqual(argv[argv.index('--effort') + 1], 'medium')
            text = argv[argv.index('--append-system-prompt') + 1]
            self.assertIn('Shared team execution policy', text)
            self.assertIn('# Investigate', text)
            self.assertNotIn('ANTHROPIC_API_KEY', env)
            self.assertNotIn('CLAUDE_CODE_SAFE_MODE', env)
            self.assertEqual(env['CLAUDE_CONFIG_DIR'], '/profile')
            job['resume'] = True
            argv, _ = build(job)
            self.assertNotIn('--session-id', argv)
            self.assertEqual(argv[argv.index('--resume') + 1], job['sessionId'])

    def test_configuration_rejects_provider_overrides_without_echoing_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            profile, project = root / 'profile', root / 'project'
            profile.mkdir()
            (project / '.claude').mkdir(parents=True)
            (profile / 'settings.json').write_text('{}')
            auth.validate_configuration(profile, project)
            for value in ({'env': {'ANTHROPIC_API_KEY': 'hidden'}}, {'apiKeyHelper': 'hidden'}, []):
                (project / '.claude/settings.json').write_text(json.dumps(value))
                with self.assertRaises(auth.Refused) as error:
                    auth.validate_configuration(profile, project)
                self.assertNotIn('hidden', str(error.exception))

    def test_fixed_profile_wrapper_forwards_only_its_profile(self):
        with patch.object(cli, 'main', return_value=0) as main:
            self.assertEqual(cli.fixed_profile_entry('team2', ['--repo', '/repo', '--workflow', 'investigate', '-p', 'prompt']), 0)
            argv = main.call_args.args[0]
            self.assertEqual(argv[argv.index('--profile') + 1], 'team2')
            self.assertEqual(argv[-3:], ['--', '-p', 'prompt'])
        with patch.object(cli, 'main', return_value=0) as main:
            cli.fixed_profile_entry('team2', ['--check'])
            self.assertEqual(main.call_args.args[0], ['doctor', '--profile', 'team2', '--json'])

    def test_changed_cli_fails_before_inference(self):
        with patch.object(auth, 'profile_settings', return_value=('one@example.invalid', '/profile')), \
             patch.object(auth, 'verify_login'), \
             patch.object(cli, 'check_cli_version', return_value={'ok': False}):
            build, _ = cli.prepare_builder('team1', [], 'implement')
            with self.assertRaises(RuntimeRefused):
                build({'worktree': '/job', 'sessionId': 'id'})

    def test_resume_options_can_follow_job_before_separator(self):
        args = cli.parse_invocation(['resume', 'job-fixture', '--timeout', '30', '--', '-p', 'continue'])
        self.assertEqual(args.timeout, 30)
        self.assertEqual(args.job, 'job-fixture')
        self.assertEqual(args.native, ['-p', 'continue'])


if __name__ == '__main__':
    unittest.main()
