import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from native_runtime.core import RuntimeConfig, now, process_identity, read_job, state_lock, write_job
from native_runtime.factory_lease import ProtocolError, validate_worktree
from native_runtime.supervisor import list_jobs, _reserve as reserve_native


SOURCE = Path(__file__).resolve().parents[1]


class FactoryLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.repo, self.worktree = self.root / 'repo', self.root / 'worktree'
        self.repo.mkdir()
        for args in [('init', '-q'), ('config', 'user.name', 'Fixture'),
                     ('config', 'user.email', 'fixture@example.invalid')]:
            self.git(self.repo, *args)
        (self.repo / 'tracked.txt').write_text('original\n')
        self.git(self.repo, 'add', 'tracked.txt')
        self.git(self.repo, 'commit', '-qm', 'fixture')
        self.git(self.repo, 'worktree', 'add', '-qb', 'factory-fixture', str(self.worktree))
        (self.repo / 'tracked.txt').write_text('unsaved source edit\n')
        (self.repo / '.env').write_text('fixture-not-a-real-secret\n')
        self.state = self.root / 'state'
        self.config = RuntimeConfig(self.state, self.state, max_running=2)
        self.children, self.buffers = [], {}

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                try:
                    self.send(child, {'op': 'release', 'state': 'cancelled', 'cleanupVerified': True})
                    child.wait(timeout=1)
                except (OSError, subprocess.TimeoutExpired):
                    child.kill()
                    child.wait(timeout=2)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream:
                    stream.close()
        self.temp.cleanup()

    def git(self, root, *args):
        return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL).decode().strip()

    def start(self, max_running=2):
        child = subprocess.Popen([sys.executable, '-m', 'native_runtime.factory_lease',
                                  '--state-root', str(self.state), '--max-running', str(max_running)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=dict(os.environ, PYTHONPATH=str(SOURCE), PYTHONDONTWRITEBYTECODE='1'))
        self.children.append(child)
        self.buffers[child.pid] = b''
        return child

    def send(self, child, value):
        child.stdin.write(json.dumps(value).encode() + b'\n')
        child.stdin.flush()

    def receive(self, child, timeout=3):
        deadline = time.monotonic() + timeout
        while b'\n' not in self.buffers[child.pid]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            ready, _, _ = select.select([child.stdout], [], [], remaining)
            if not ready:
                return None
            chunk = os.read(child.stdout.fileno(), 65536)
            if not chunk:
                return None
            self.buffers[child.pid] += chunk
        line, self.buffers[child.pid] = self.buffers[child.pid].split(b'\n', 1)
        return json.loads(line)

    def request(self, suffix='one', cwd=None, op='acquire', **extra):
        return {'op': op, 'factorySessionId': 'factory-' + suffix, 'bridgeSessionId': 'bridge-' + suffix,
                'cwd': str(cwd or self.worktree), 'role': 'worker', **extra}

    def admitted(self, suffix='one', cwd=None, **extra):
        child = self.start()
        self.send(child, self.request(suffix, cwd, **extra))
        queued = self.receive(child)
        self.assertEqual(queued['event'], 'queued')
        ready = self.receive(child)
        self.assertEqual(ready['event'], 'ready')
        return child, ready['jobId']

    def release(self, child, state='idle', **extra):
        self.send(child, {'op': 'release', 'state': state, **extra})
        result = self.receive(child)
        self.assertEqual(result['event'], 'released')
        self.assertEqual(child.wait(timeout=3), 0)
        return result

    def test_existing_workspace_and_phase_resume_preserve_source(self):
        child, job_id = self.admitted()
        self.release(child, 'waiting_host', usage={'input_tokens': 5, 'output_tokens': 2},
                     sdkSessionId='65037c83-9ea1-482a-af3e-0486d46db6cf', cleanupVerified=False)
        first = read_job(self.config, job_id)
        self.assertEqual(first['profile'], 'factory-api')
        self.assertEqual(first['kind'], 'factory-session')
        self.assertEqual(first['worktree'], str(self.worktree))
        self.assertEqual(first['leaseOwnerIdentity'], process_identity(os.getpid()))
        self.assertFalse(first['externalCleanupRequired'])
        self.assertIsNone(first['cleanupVerified'])
        self.assertFalse(first['reportedCleanupVerified'])
        self.assertEqual(first['reportedPhaseUsage']['input_tokens'], 5)
        second, same_id = self.admitted()
        self.assertEqual(same_id, job_id)
        self.release(second)
        self.assertEqual(read_job(self.config, job_id)['attempt'], 2)
        self.assertEqual((self.repo / 'tracked.txt').read_text(), 'unsaved source edit\n')
        self.assertFalse((self.worktree / '.env').exists())

    def test_main_checkout_subdirectory_symlink_and_invalid_ids_are_refused(self):
        with self.assertRaises(ProtocolError):
            validate_worktree(str(self.repo))
        (self.worktree / 'nested').mkdir()
        with self.assertRaises(ProtocolError):
            validate_worktree(str(self.worktree / 'nested'))
        link = self.root / 'link'
        link.symlink_to(self.worktree)
        with self.assertRaises(ProtocolError):
            validate_worktree(str(link))
        child = self.start()
        self.send(child, self.request(factorySessionId='../secret'))
        self.assertFalse(self.receive(child)['ok'])
        self.assertEqual(child.wait(timeout=3), 2)

    def test_host_controller_accepts_owned_directories_without_inventing_git_metadata(self):
        folder = self.root / 'ordinary-folder'
        folder.mkdir()
        for path in (folder, self.repo, self.worktree / '.git-does-not-exist'):
            if not path.exists():
                path.mkdir()
            with mock.patch('native_runtime.factory_lease.git', side_effect=AssertionError('host folder must not require Git')):
                value = validate_worktree(str(path), 'controller-host')
            self.assertEqual(value, {'worktree': str(path), 'workspaceKind': 'directory',
                                     'repository': None, 'branch': None, 'sourceCommit': None})
        child, job_id = self.admitted('folder-host', folder, role='orchestrator', subscriptionProfile='team7',
                                      workspacePolicy='controller-host')
        saved = read_job(self.config, job_id)
        self.assertEqual(saved['workspaceKind'], 'directory')
        self.assertIsNone(saved['repository'])
        self.assertIsNone(saved['sourceCommit'])
        self.release(child, 'completed', cleanupVerified=True)

    def test_host_folder_policy_refuses_symlinks_nonowners_and_forged_roles(self):
        link = self.root / 'host-link'
        link.symlink_to(self.repo)
        with self.assertRaises(ProtocolError):
            validate_worktree(str(link), 'controller-host')
        actual_uid = os.getuid()
        with mock.patch('native_runtime.factory_lease.os.getuid', return_value=actual_uid + 1):
            with self.assertRaises(ProtocolError):
                validate_worktree(str(self.repo), 'controller-host')
        for values in ({'role': 'worker', 'subscriptionProfile': 'team1'},
                       {'role': 'validator', 'subscriptionProfile': 'team1'},
                       {'role': 'unknown', 'subscriptionProfile': 'team1'},
                       {'role': 'chat'}):
            child = self.start()
            self.send(child, self.request(cwd=self.root, workspacePolicy='controller-host', **values))
            result = self.receive(child)
            self.assertEqual(result, {'ok': False, 'error': 'factory_lease_refused', 'code': 'invalid_binding'})
            self.assertEqual(child.wait(timeout=3), 2)
        self.assertEqual(list((self.state / 'jobs').glob('*.json')), [])

    def test_host_overlap_waits_for_active_child_but_not_idle_bound_controller(self):
        reader, _ = self.admitted('read-child', self.repo, role='chat', subscriptionProfile='team2',
                                  workspacePolicy='controller-readonly')
        host = self.start()
        self.send(host, self.request('parent-host', self.root, role='orchestrator', subscriptionProfile='team1',
                                     workspacePolicy='controller-host'))
        self.assertEqual(self.receive(host)['event'], 'queued')
        self.assertIsNone(self.receive(host, .15))
        self.release(reader, 'idle')
        self.assertEqual(self.receive(host)['event'], 'ready')
        descendant = self.start()
        self.send(descendant, self.request('child-writer', self.worktree, subscriptionProfile='team3'))
        self.assertEqual(self.receive(descendant)['event'], 'queued')
        self.assertIsNone(self.receive(descendant, .15))
        self.release(host, 'idle')
        self.assertEqual(self.receive(descendant)['event'], 'ready')
        self.release(descendant, 'completed', cleanupVerified=True)

    def test_native_scheduler_waits_for_overlapping_host_lease(self):
        host, _ = self.admitted('parent-host', self.root, role='chat', subscriptionProfile='team1',
                                workspacePolicy='controller-host')
        native = {'id': 'native-host-overlap', 'profile': 'team2', 'state': 'waiting_slot',
                  'supervisorIdentity': process_identity(os.getpid()), 'createdAt': now(),
                  'queuedAt': now(), 'worktree': str(self.worktree)}
        with state_lock(self.config):
            write_job(self.config, native)
        self.assertEqual(reserve_native(self.config, native), 'wait')
        self.release(host, 'idle')
        self.assertEqual(reserve_native(self.config, native), 'start')

    def test_host_policy_cannot_be_changed_during_resume_or_completion(self):
        child, job_id = self.admitted('policy-host', self.repo, role='chat', subscriptionProfile='team1',
                                      workspacePolicy='controller-host')
        self.release(child, 'waiting_host')
        path = self.state / 'jobs' / (job_id + '.json')
        original = path.read_bytes()
        for operation in ('acquire', 'update'):
            child = self.start()
            extra = {'state': 'completed', 'cleanupVerified': True} if operation == 'update' else {}
            self.send(child, self.request('policy-host', self.repo, op=operation, role='chat', subscriptionProfile='team1',
                                          workspacePolicy='controller-readonly', **extra))
            self.assertFalse(self.receive(child)['ok'])
            self.assertEqual(child.wait(timeout=3), 2)
            self.assertEqual(path.read_bytes(), original)

    def test_host_policy_migration_requires_a_fresh_native_generation(self):
        original, original_id = self.admitted('migration', self.repo, role='chat', subscriptionProfile='team1',
                                              workspacePolicy='controller-readonly', bridgeSessionId='bridge-migration:g0')
        self.release(original, 'failed', cleanupVerified=True)
        rejected = self.start()
        self.send(rejected, self.request('migration', self.repo, role='chat', subscriptionProfile='team1',
                                         workspacePolicy='controller-host', bridgeSessionId='bridge-migration:g0'))
        self.assertFalse(self.receive(rejected)['ok'])
        self.assertEqual(rejected.wait(timeout=3), 2)
        fresh, fresh_id = self.admitted('migration', self.repo, role='chat', subscriptionProfile='team1',
                                       workspacePolicy='controller-host', bridgeSessionId='bridge-migration:g1')
        self.assertNotEqual(fresh_id, original_id)
        self.assertEqual(read_job(self.config, original_id)['workspacePolicy'], 'controller-readonly')
        self.assertEqual(read_job(self.config, original_id)['state'], 'failed')
        self.assertEqual(read_job(self.config, fresh_id)['workspacePolicy'], 'controller-host')
        self.release(fresh, 'completed', cleanupVerified=True)

    def test_permanent_workspace_rejection_has_a_sanitized_wire_category(self):
        child = self.start()
        self.send(child, self.request('bad-folder', self.root / 'missing', role='chat', subscriptionProfile='team1',
                                     workspacePolicy='controller-host'))
        result = self.receive(child)
        self.assertEqual(result, {'ok': False, 'error': 'factory_lease_refused', 'code': 'invalid_workspace'})
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(child.wait(timeout=3), 2)

    def test_primary_checkout_requires_explicit_fixed_seat_readonly_controller_policy(self):
        child, job_id = self.admitted(cwd=self.repo, role='chat', subscriptionProfile='team8',
                                      workspacePolicy='controller-readonly')
        saved = read_job(self.config, job_id)
        self.assertEqual(saved['worktree'], str(self.repo))
        self.assertEqual(saved['workspacePolicy'], 'controller-readonly')
        self.assertEqual(saved['profile'], 'team8')
        self.release(child)
        self.assertEqual((self.repo / 'tracked.txt').read_text(), 'unsaved source edit\n')
        self.assertEqual((self.repo / '.env').read_text(), 'fixture-not-a-real-secret\n')

    def test_forged_controller_policy_and_worker_role_cannot_open_primary_checkout(self):
        variants = [
            {'workspacePolicy': 'controller-readonly', 'role': 'chat'},
            {'workspacePolicy': 'controller-readonly', 'subscriptionProfile': 'team1', 'role': 'worker'},
            {'workspacePolicy': 'controller-readonly', 'subscriptionProfile': 'team1', 'role': 'validator'},
            {'workspacePolicy': 'write-anywhere', 'subscriptionProfile': 'team1', 'role': 'chat'},
            {'workspacePolicy': True, 'subscriptionProfile': 'team1', 'role': 'chat'},
            {'workspacePolicy': None, 'subscriptionProfile': 'team1', 'role': 'chat'},
        ]
        for variant in variants:
            with self.subTest(variant=variant):
                child = self.start()
                self.send(child, self.request(cwd=self.repo, **variant))
                self.assertFalse(self.receive(child)['ok'])
                self.assertEqual(child.wait(timeout=3), 2)
        self.assertEqual(list((self.state / 'jobs').glob('*.json')), [])

    def test_controller_workspace_policy_is_immutable_on_resume_and_update(self):
        child, job_id = self.admitted(role='chat', subscriptionProfile='team1', workspacePolicy='controller-readonly')
        self.release(child, 'waiting_host')
        path = self.state / 'jobs' / (job_id + '.json')
        original = path.read_bytes()
        for operation in ('acquire', 'update'):
            child = self.start()
            extra = {'state': 'completed', 'cleanupVerified': True} if operation == 'update' else {}
            self.send(child, self.request(op=operation, role='chat', subscriptionProfile='team1', **extra))
            self.assertFalse(self.receive(child)['ok'])
            self.assertEqual(child.wait(timeout=3), 2)
            self.assertEqual(path.read_bytes(), original)
        resumed, same_id = self.admitted(role='chat', subscriptionProfile='team1', workspacePolicy='controller-readonly')
        self.assertEqual(same_id, job_id)
        self.release(resumed)

    def test_readonly_controllers_may_share_primary_checkout_but_not_a_writer_workspace(self):
        first, _ = self.admitted('controller-one', self.repo, role='chat', subscriptionProfile='team1', workspacePolicy='controller-readonly')
        second, _ = self.admitted('controller-two', self.repo, role='orchestrator', subscriptionProfile='team2', workspacePolicy='controller-readonly')
        self.release(first)
        self.release(second)
        reader, _ = self.admitted('reader', self.worktree, role='chat', subscriptionProfile='team1', workspacePolicy='controller-readonly')
        writer = self.start()
        self.send(writer, self.request('writer', self.worktree, role='worker', subscriptionProfile='team2'))
        self.assertFalse(self.receive(writer)['ok'])
        self.assertEqual(writer.wait(timeout=3), 2)
        self.release(reader)

    def test_global_admission_counts_native_jobs_and_cancel_queued(self):
        with state_lock(self.config):
            write_job(self.config, {'id': 'native-fixture', 'profile': 'team1', 'state': 'running',
                                    'supervisorIdentity': process_identity(os.getpid()), 'createdAt': now(),
                                    'worktree': str(self.root / 'other')})
        child = self.start(max_running=1)
        self.send(child, self.request())
        queued = self.receive(child)
        self.assertEqual(queued['event'], 'queued')
        self.assertIsNone(self.receive(child, .15))
        self.send(child, {'op': 'cancel'})
        self.assertEqual(self.receive(child)['event'], 'cancelled')
        self.assertEqual(child.wait(timeout=3), 0)
        job = read_job(self.config, queued['jobId'])
        self.assertEqual(job['state'], 'cancelled')
        self.assertNotIn('admittedAt', job)

    def test_two_distinct_factory_requests_can_share_global_capacity(self):
        other = self.root / 'other-worktree'
        self.git(self.repo, 'worktree', 'add', '-qb', 'other-factory', str(other))
        one, _ = self.admitted('one')
        two, _ = self.admitted('two', other)
        self.release(one)
        self.release(two)

    def test_subscription_profile_is_persisted_and_immutable_on_resume_and_update(self):
        child, job_id = self.admitted(subscriptionProfile='team8')
        self.release(child, 'waiting_host')
        saved = read_job(self.config, job_id)
        self.assertEqual(saved['profile'], 'team8')
        self.assertEqual(saved['subscriptionProfile'], 'team8')
        self.assertEqual(saved['authMode'], 'subscription')
        original = (self.state / 'jobs' / (job_id + '.json')).read_bytes()
        for extra in ({}, {'subscriptionProfile': 'team2'}):
            for operation in ('acquire', 'update'):
                rejected = self.start()
                values = dict(extra)
                if operation == 'update':
                    values.update(state='completed', cleanupVerified=True)
                self.send(rejected, self.request(op=operation, **values))
                self.assertFalse(self.receive(rejected)['ok'])
                self.assertEqual(rejected.wait(timeout=3), 2)
                self.assertEqual((self.state / 'jobs' / (job_id + '.json')).read_bytes(), original)
        resumed, resumed_id = self.admitted(subscriptionProfile='team8')
        self.assertEqual(resumed_id, job_id)
        self.release(resumed)
        update = self.start()
        self.send(update, self.request(op='update', subscriptionProfile='team8', state='completed', cleanupVerified=True))
        self.assertEqual(self.receive(update)['event'], 'updated')
        self.assertEqual(update.wait(timeout=3), 0)

    def test_invalid_subscription_profiles_fail_before_any_job_record(self):
        for profile in ('team0', 'team9', 'team01', '', 'factory-api', None, True, {'profile': 'team1'}):
            with self.subTest(profile=profile):
                child = self.start()
                self.send(child, self.request(subscriptionProfile=profile))
                self.assertFalse(self.receive(child)['ok'])
                self.assertEqual(child.wait(timeout=3), 2)
        self.assertEqual(list((self.state / 'jobs').glob('*.json')), [])

    def test_all_eight_fixed_profiles_are_admitted_without_rotation(self):
        for number in range(1, 9):
            profile = 'team' + str(number)
            with self.subTest(profile=profile):
                child, job_id = self.admitted('seat-' + str(number), subscriptionProfile=profile)
                saved = read_job(self.config, job_id)
                self.assertEqual(saved['profile'], profile)
                self.assertEqual(saved['subscriptionProfile'], profile)
                self.assertEqual(saved['authMode'], 'subscription')
                self.release(child, 'completed', cleanupVerified=True)

    def test_subscription_waits_for_the_same_native_seat_even_with_global_capacity(self):
        with state_lock(self.config):
            write_job(self.config, {'id': 'native-fixture', 'profile': 'team1', 'state': 'running',
                                    'supervisorIdentity': process_identity(os.getpid()), 'createdAt': now(),
                                    'worktree': str(self.root / 'native-worktree')})
        waiting = self.start()
        self.send(waiting, self.request(subscriptionProfile='team1'))
        job_id = self.receive(waiting)['jobId']
        self.assertIsNone(self.receive(waiting, .15))
        other = self.root / 'team2-worktree'
        self.git(self.repo, 'worktree', 'add', '-qb', 'team2-worktree', str(other))
        second, _ = self.admitted('team2', other, subscriptionProfile='team2')
        self.assertIsNone(self.receive(waiting, .1))
        self.release(second)
        with state_lock(self.config):
            native = read_job(self.config, 'native-fixture')
            native['state'] = 'completed'
            write_job(self.config, native)
        self.assertEqual(self.receive(waiting)['event'], 'ready')
        self.assertEqual(read_job(self.config, job_id)['profile'], 'team1')
        self.release(waiting)

    def test_subscription_seat_serializes_factory_workers_and_native_admission(self):
        first, _ = self.admitted(subscriptionProfile='team1')
        second_tree = self.root / 'same-seat-worktree'
        third_tree = self.root / 'different-seat-worktree'
        self.git(self.repo, 'worktree', 'add', '-qb', 'same-seat', str(second_tree))
        self.git(self.repo, 'worktree', 'add', '-qb', 'different-seat', str(third_tree))
        second = self.start()
        self.send(second, self.request('same-seat', second_tree, subscriptionProfile='team1'))
        self.assertEqual(self.receive(second)['event'], 'queued')
        self.assertIsNone(self.receive(second, .15))
        third, _ = self.admitted('different-seat', third_tree, subscriptionProfile='team2')
        self.release(third)
        with state_lock(self.config):
            native = {'id': 'native-queued', 'profile': 'team1', 'state': 'waiting_slot',
                      'supervisorIdentity': process_identity(os.getpid()), 'createdAt': now(),
                      'queuedAt': now(), 'worktree': str(self.root / 'native-worktree')}
            write_job(self.config, native)
        self.assertEqual(reserve_native(self.config, native), 'wait')
        self.release(first)
        self.assertEqual(self.receive(second)['event'], 'ready')
        self.assertEqual(reserve_native(self.config, native), 'wait')
        self.release(second)
        self.assertEqual(reserve_native(self.config, native), 'start')

    def test_distinct_subscription_seats_still_share_the_global_two_job_limit(self):
        second_tree = self.root / 'second-seat-worktree'
        third_tree = self.root / 'third-seat-worktree'
        self.git(self.repo, 'worktree', 'add', '-qb', 'second-seat', str(second_tree))
        self.git(self.repo, 'worktree', 'add', '-qb', 'third-seat', str(third_tree))
        first, _ = self.admitted(subscriptionProfile='team5')
        second, _ = self.admitted('second-seat', second_tree, subscriptionProfile='team6')
        third = self.start()
        self.send(third, self.request('third-seat', third_tree, subscriptionProfile='team8'))
        self.assertEqual(self.receive(third)['event'], 'queued')
        self.assertIsNone(self.receive(third, .15))
        self.release(first)
        self.assertEqual(self.receive(third)['event'], 'ready')
        self.release(second)
        self.release(third)

    def test_workspace_cannot_be_bound_to_a_second_open_session(self):
        one, _ = self.admitted('one')
        self.release(one, 'waiting_host')
        two = self.start()
        self.send(two, self.request('two'))
        self.assertFalse(self.receive(two)['ok'])
        self.assertEqual(two.wait(timeout=3), 2)

    def test_eof_queued_releases_but_eof_admitted_retains_unknown(self):
        with state_lock(self.config):
            write_job(self.config, {'id': 'native-fixture', 'profile': 'team1', 'state': 'running',
                                    'supervisorIdentity': process_identity(os.getpid()), 'createdAt': now(),
                                    'worktree': str(self.root / 'other')})
        queued = self.start(max_running=1)
        self.send(queued, self.request('queued'))
        queued_id = self.receive(queued)['jobId']
        self.assertIsNone(self.receive(queued, .1))
        queued.stdin.close()
        self.assertFalse(self.receive(queued)['ok'])
        self.assertEqual(queued.wait(timeout=3), 2)
        self.assertEqual(read_job(self.config, queued_id)['state'], 'cancelled')
        with state_lock(self.config):
            native = read_job(self.config, 'native-fixture')
            native['state'] = 'completed'
            write_job(self.config, native)
        child, job_id = self.admitted()
        child.stdin.close()
        self.assertFalse(self.receive(child)['ok'])
        self.assertEqual(child.wait(timeout=3), 2)
        jobs = list_jobs(self.config)
        job = next(item for item in jobs if item['id'] == job_id)
        self.assertEqual(job['state'], 'unknown')
        self.assertTrue(job['externalCleanupRequired'])
        self.assertIsNone(job['cleanupVerified'])
        # Same actual bridge owner may resolve the unknown only with cleanup proof.
        invalid = self.start()
        self.send(invalid, self.request(op='update', state='cancelled'))
        self.assertFalse(self.receive(invalid)['ok'])
        self.assertEqual(invalid.wait(timeout=3), 2)
        update = self.start()
        self.send(update, self.request(op='update', state='cancelled', cleanupVerified=True))
        self.assertEqual(self.receive(update)['event'], 'updated')
        self.assertEqual(update.wait(timeout=3), 0)
        self.assertEqual(read_job(self.config, job_id)['state'], 'cancelled')
        self.assertFalse(read_job(self.config, job_id)['externalCleanupRequired'])

    def test_unknown_release_keeps_capacity_until_explicit_update(self):
        child, job_id = self.admitted()
        self.release(child, 'unknown', cleanupVerified=False)
        self.assertTrue(read_job(self.config, job_id)['externalCleanupRequired'])
        again = self.start()
        self.send(again, self.request())
        self.assertFalse(self.receive(again)['ok'])
        self.assertEqual(again.wait(timeout=3), 2)

    def test_helper_crash_does_not_release_external_execution(self):
        child, job_id = self.admitted()
        child.kill()
        child.wait(timeout=3)
        job = next(item for item in list_jobs(self.config) if item['id'] == job_id)
        self.assertEqual(job['state'], 'unknown')
        self.assertTrue(job['externalCleanupRequired'])
        self.assertEqual(job['ownedProcesses'], [])
        self.assertEqual(job['leaseOwnerIdentity'], process_identity(os.getpid()))

    def test_invalid_or_sensitive_fields_are_not_persisted_or_echoed(self):
        child, job_id = self.admitted()
        self.send(child, {'op': 'release', 'state': 'idle', 'usage': {'secret-token': 'never-copy-this'}})
        result = self.receive(child)
        self.assertFalse(result['ok'])
        self.assertEqual(child.wait(timeout=3), 2)
        self.assertNotIn('never-copy-this', json.dumps(result))
        self.assertNotIn('never-copy-this', (self.state / 'jobs' / (job_id + '.json')).read_text())
        self.assertTrue(read_job(self.config, job_id)['externalCleanupRequired'])

    def test_update_requires_the_original_parent_identity(self):
        child, job_id = self.admitted()
        self.release(child)
        with state_lock(self.config):
            job = read_job(self.config, job_id)
            job['leaseOwnerIdentity']['start'] = 'different process generation'
            write_job(self.config, job)
        update = self.start()
        self.send(update, self.request(op='update', state='completed', cleanupVerified=True))
        self.assertFalse(self.receive(update)['ok'])
        self.assertEqual(update.wait(timeout=3), 2)
        self.assertEqual(read_job(self.config, job_id)['state'], 'idle')


if __name__ == '__main__':
    unittest.main()
