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
from native_runtime.reporting import report_jobs
from native_runtime.supervisor import execution_lane, list_jobs, _reserve as reserve_native


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

    def test_host_action_reservation_releases_compute_for_other_workstreams(self):
        first_dir, second_dir, third_dir = (self.root / name for name in ('first', 'second', 'third'))
        for folder in (first_dir, second_dir, third_dir):
            folder.mkdir()
        first, first_id = self.admitted('first', first_dir, role='chat', subscriptionProfile='team1',
                                        workspacePolicy='controller-host')
        self.release(first, 'waiting_host', hostActionReservation=True, cleanupVerified=False)
        self.assertTrue(read_job(self.config, first_id)['hostActionReservation'])
        second, _ = self.admitted('second', second_dir, role='chat', subscriptionProfile='team1',
                                  workspacePolicy='controller-host')
        third = self.start()
        self.send(third, self.request('third', third_dir, role='chat', subscriptionProfile='team8',
                                     workspacePolicy='controller-host'))
        self.assertEqual(self.receive(third)['event'], 'queued')
        self.assertIsNone(self.receive(third, .1))
        self.release(second, 'idle')
        self.assertEqual(self.receive(third)['event'], 'ready')
        self.release(third, 'idle')
        self.assertTrue(read_job(self.config, first_id)['hostActionReservation'])
        overlap = self.start()
        self.send(overlap, self.request('overlap', first_dir, role='chat', subscriptionProfile='team2',
                                       workspacePolicy='controller-host'))
        self.assertEqual(self.receive(overlap)['event'], 'queued')
        self.assertIsNone(self.receive(overlap, .1))
        self.send(overlap, {'op': 'cancel'})
        self.assertEqual(self.receive(overlap)['event'], 'cancelled')
        self.assertEqual(overlap.wait(timeout=3), 0)
        resumed, same_id = self.admitted('first', first_dir, role='chat', subscriptionProfile='team1',
                                        workspacePolicy='controller-host')
        self.assertEqual(first_id, same_id)
        self.release(resumed, 'idle')
        self.assertFalse(read_job(self.config, first_id)['hostActionReservation'])

    def test_unknown_host_action_blocks_its_workspace_without_consuming_controller_slot(self):
        other = self.root / 'other-host'
        other.mkdir()
        first, first_id = self.admitted('uncertain-host', self.repo, role='chat', subscriptionProfile='team1',
                                        workspacePolicy='controller-host')
        self.release(first, 'unknown', hostActionReservation=True, cleanupVerified=True)
        next_host, _ = self.admitted('next-host', other, role='chat', subscriptionProfile='team1',
                                     workspacePolicy='controller-host')
        self.release(next_host, 'idle')
        blocked = self.start()
        self.send(blocked, self.request('blocked-host', self.repo, role='chat', subscriptionProfile='team2',
                                       workspacePolicy='controller-host'))
        self.assertEqual(self.receive(blocked)['event'], 'queued')
        self.assertIsNone(self.receive(blocked, .1))
        self.assertTrue(read_job(self.config, first_id)['externalCleanupRequired'])

    def test_unknown_native_cleanup_retains_controller_compute_and_account(self):
        other = self.root / 'other-after-cleanup-failure'
        other.mkdir()
        first, _ = self.admitted('cleanup-failure', self.repo, role='chat', subscriptionProfile='team1',
                                  workspacePolicy='controller-host')
        self.release(first, 'unknown', hostActionReservation=True, cleanupVerified=False)
        controller = self.start()
        self.send(controller, self.request('after-cleanup-failure', other, role='chat', subscriptionProfile='team1',
                                           workspacePolicy='controller-host'))
        self.assertEqual(self.receive(controller)['event'], 'queued')
        self.assertIsNone(self.receive(controller, .15))
        worker = self.start()
        self.send(worker, self.request('worker-after-cleanup-failure', subscriptionProfile='team1'))
        self.assertEqual(self.receive(worker)['event'], 'queued')
        self.assertIsNone(self.receive(worker, .15))

    def test_deferred_admission_restores_prior_workspace_reservation(self):
        other = self.root / 'busy-host'
        other.mkdir()
        first, first_id = self.admitted('resume-host', self.repo, role='chat', subscriptionProfile='team1',
                                        workspacePolicy='controller-host')
        self.release(first, 'waiting_host', hostActionReservation=True, cleanupVerified=False)
        busy, _ = self.admitted('busy-host', other, role='chat', subscriptionProfile='team2',
                                workspacePolicy='controller-host')
        queued = self.start()
        self.send(queued, self.request('resume-host', self.repo, role='chat', subscriptionProfile='team1',
                                      workspacePolicy='controller-host'))
        self.assertEqual(self.receive(queued)['event'], 'queued')
        self.send(queued, {'op': 'defer'})
        self.assertEqual(self.receive(queued)['event'], 'deferred')
        self.assertEqual(queued.wait(timeout=3), 0)
        waiting = read_job(self.config, first_id)
        self.assertEqual(waiting['state'], 'waiting_host')
        self.assertTrue(waiting['hostActionReservation'])
        self.release(busy, 'idle')
        resumed, same_id = self.admitted('resume-host', self.repo, role='chat', subscriptionProfile='team1',
                                        workspacePolicy='controller-host')
        self.assertEqual(same_id, first_id)
        self.release(resumed, 'idle')

    def test_cancelled_readmission_keeps_the_unfinished_host_action_reserved(self):
        other = self.root / 'busy-readmission'
        other.mkdir()
        first, first_id = self.admitted('cancel-readmission', self.repo, role='chat', subscriptionProfile='team1',
                                        workspacePolicy='controller-host')
        self.release(first, 'waiting_host', hostActionReservation=True, cleanupVerified=False)
        busy, _ = self.admitted('busy-readmission', other, role='chat', subscriptionProfile='team2',
                                workspacePolicy='controller-host')
        queued = self.start()
        self.send(queued, self.request('cancel-readmission', self.repo, role='chat', subscriptionProfile='team1',
                                      workspacePolicy='controller-host'))
        self.assertEqual(self.receive(queued)['event'], 'queued')
        self.send(queued, {'op': 'cancel'})
        self.assertEqual(self.receive(queued)['event'], 'cancelled')
        self.assertEqual(queued.wait(timeout=3), 0)
        waiting = read_job(self.config, first_id)
        self.assertEqual(waiting['state'], 'waiting_host')
        self.assertTrue(waiting['hostActionReservation'])
        self.release(busy, 'idle')

    def test_defer_after_ready_restores_an_unexecuted_phase_for_retry(self):
        first, first_id = self.admitted('ready-race')
        self.send(first, {'op': 'defer'})
        self.assertEqual(self.receive(first)['event'], 'deferred')
        self.assertEqual(first.wait(timeout=3), 0)
        self.assertEqual(read_job(self.config, first_id)['state'], 'idle')
        retry, retry_id = self.admitted('ready-race')
        self.assertEqual(first_id, retry_id)
        self.release(retry, 'completed', cleanupVerified=True)

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

    def test_readonly_controllers_share_checkout_with_serialized_execution(self):
        first, _ = self.admitted('controller-one', self.repo, role='chat', subscriptionProfile='team1', workspacePolicy='controller-readonly')
        second = self.start()
        self.send(second, self.request('controller-two', self.repo, role='orchestrator',
                                       subscriptionProfile='team2', workspacePolicy='controller-readonly'))
        self.assertEqual(self.receive(second)['event'], 'queued')
        self.assertIsNone(self.receive(second, .15))
        self.release(first)
        self.assertEqual(self.receive(second)['event'], 'ready')
        self.release(second)
        reader, _ = self.admitted('reader', self.worktree, role='chat', subscriptionProfile='team1', workspacePolicy='controller-readonly')
        writer = self.start()
        self.send(writer, self.request('writer', self.worktree, role='worker', subscriptionProfile='team2'))
        self.assertFalse(self.receive(writer)['ok'])
        self.assertEqual(writer.wait(timeout=3), 2)
        self.release(reader)

    def test_controller_capacity_remains_available_with_two_workers_and_an_older_queue(self):
        second_tree = self.root / 'second-worker'
        third_tree = self.root / 'third-worker'
        self.git(self.repo, 'worktree', 'add', '-qb', 'second-worker', str(second_tree))
        self.git(self.repo, 'worktree', 'add', '-qb', 'third-worker', str(third_tree))
        first, _ = self.admitted('first-worker', subscriptionProfile='team1')
        second, _ = self.admitted('second-worker', second_tree, subscriptionProfile='team2')
        third = self.start()
        self.send(third, self.request('third-worker', third_tree, subscriptionProfile='team3'))
        self.assertEqual(self.receive(third)['event'], 'queued')
        self.assertIsNone(self.receive(third, .15))

        controller, _ = self.admitted('controller', self.repo, role='orchestrator',
                                      subscriptionProfile='team1', workspacePolicy='controller-readonly')
        running = [job for job in list_jobs(self.config) if job['state'] == 'running']
        self.assertEqual(sum(execution_lane(job) == 'worker' for job in running), 2)
        self.assertEqual(sum(execution_lane(job) == 'controller' for job in running), 1)
        another_controller = self.start()
        self.send(another_controller, self.request('another-controller', self.repo,
                  role='chat', subscriptionProfile='team4', workspacePolicy='controller-readonly'))
        self.assertEqual(self.receive(another_controller)['event'], 'queued')
        self.assertIsNone(self.receive(another_controller, .15))
        self.assertIsNone(self.receive(third, .1))

        self.release(controller, 'completed', cleanupVerified=True)
        self.assertEqual(self.receive(another_controller)['event'], 'ready')
        self.assertIsNone(self.receive(third, .1))
        self.release(first, 'completed', cleanupVerified=True)
        self.assertEqual(self.receive(third)['event'], 'ready')
        self.release(second, 'completed', cleanupVerified=True)
        self.release(third, 'completed', cleanupVerified=True)
        self.release(another_controller, 'completed', cleanupVerified=True)

    def test_uncertain_worker_blocks_its_account_across_lanes_until_cleanup(self):
        first, _ = self.admitted('uncertain-worker', subscriptionProfile='team1')
        self.release(first, 'unknown', cleanupVerified=False)
        same_account = self.start()
        self.send(same_account, self.request('blocked-controller', self.repo, role='chat',
                  subscriptionProfile='team1', workspacePolicy='controller-readonly'))
        self.assertEqual(self.receive(same_account)['event'], 'queued')
        self.assertIsNone(self.receive(same_account, .15))
        other_account, _ = self.admitted('other-controller', self.repo, role='chat',
                                         subscriptionProfile='team2', workspacePolicy='controller-readonly')
        self.release(other_account, 'completed', cleanupVerified=True)
        self.assertIsNone(self.receive(same_account, .1))

        cleanup = self.start()
        self.send(cleanup, self.request('uncertain-worker', op='update', subscriptionProfile='team1',
                                       state='cancelled', cleanupVerified=True))
        self.assertEqual(self.receive(cleanup)['event'], 'updated')
        self.assertEqual(cleanup.wait(timeout=3), 0)
        self.assertEqual(self.receive(same_account)['event'], 'ready')
        self.release(same_account, 'completed', cleanupVerified=True)

    def test_missing_external_owner_blocks_cross_lane_account_sharing(self):
        with state_lock(self.config):
            write_job(self.config, {'id': 'lost-worker-owner', 'kind': 'factory-session',
                                    'profile': 'team1', 'state': 'running',
                                    'supervisorIdentity': process_identity(os.getpid()),
                                    'leaseOwnerIdentity': None, 'externalCleanupRequired': True,
                                    'createdAt': now(), 'worktree': str(self.root / 'lost-worker')})
        blocked = self.start()
        self.send(blocked, self.request('blocked-controller', self.repo, role='chat',
                                       subscriptionProfile='team1', workspacePolicy='controller-readonly'))
        self.assertEqual(self.receive(blocked)['event'], 'queued')
        self.assertIsNone(self.receive(blocked, .15))
        other, _ = self.admitted('other-controller', self.repo, role='chat',
                                 subscriptionProfile='team2', workspacePolicy='controller-readonly')
        self.send(blocked, {'op': 'cancel'})
        self.assertEqual(self.receive(blocked)['event'], 'cancelled')
        self.assertEqual(blocked.wait(timeout=3), 0)
        self.release(other, 'completed', cleanupVerified=True)

    def test_cancelled_controller_waiter_does_not_block_the_next_controller(self):
        first, _ = self.admitted('first-controller', self.repo, role='chat',
                                 subscriptionProfile='team1', workspacePolicy='controller-readonly')
        cancelled = self.start()
        self.send(cancelled, self.request('cancelled-controller', self.repo, role='chat',
                                         subscriptionProfile='team2', workspacePolicy='controller-readonly'))
        queued = self.receive(cancelled)
        self.assertEqual(queued['event'], 'queued')
        self.assertIsNone(self.receive(cancelled, .15))
        self.send(cancelled, {'op': 'cancel'})
        self.assertEqual(self.receive(cancelled)['event'], 'cancelled')
        self.assertEqual(cancelled.wait(timeout=3), 0)
        self.assertNotIn('admittedAt', read_job(self.config, queued['jobId']))

        next_controller = self.start()
        self.send(next_controller, self.request('next-controller', self.repo, role='chat',
                                               subscriptionProfile='team3', workspacePolicy='controller-readonly'))
        self.assertEqual(self.receive(next_controller)['event'], 'queued')
        self.assertIsNone(self.receive(next_controller, .15))
        self.release(first, 'completed', cleanupVerified=True)
        self.assertEqual(self.receive(next_controller)['event'], 'ready')
        self.release(next_controller, 'completed', cleanupVerified=True)

    def test_native_worker_ignores_controller_queue_but_keeps_its_profile_limit(self):
        controller, _ = self.admitted('controller', self.repo, role='orchestrator',
                                      subscriptionProfile='team1', workspacePolicy='controller-readonly')
        queued_controller = self.start()
        self.send(queued_controller, self.request('queued-controller', self.repo, role='chat',
                  subscriptionProfile='team2', workspacePolicy='controller-readonly'))
        self.assertEqual(self.receive(queued_controller)['event'], 'queued')
        self.assertIsNone(self.receive(queued_controller, .15))

        first = {'id': 'native-first', 'kind': 'native-session', 'profile': 'team1',
                 'state': 'waiting_slot', 'supervisorIdentity': process_identity(os.getpid()),
                 'createdAt': now(), 'queuedAt': now(), 'worktree': str(self.root / 'native-first')}
        second = {'id': 'native-second', 'kind': 'native-session', 'profile': 'team1',
                  'state': 'waiting_slot', 'supervisorIdentity': process_identity(os.getpid()),
                  'createdAt': now(), 'queuedAt': now(), 'worktree': str(self.root / 'native-second')}
        with state_lock(self.config):
            write_job(self.config, first)
            write_job(self.config, second)
        self.assertEqual(reserve_native(self.config, first), 'start')
        self.assertEqual(reserve_native(self.config, second), 'wait')
        with state_lock(self.config):
            first['state'] = 'completed'
            write_job(self.config, first)
        self.assertEqual(reserve_native(self.config, second), 'start')
        self.release(controller, 'completed', cleanupVerified=True)
        self.assertEqual(self.receive(queued_controller)['event'], 'ready')
        self.release(queued_controller, 'completed', cleanupVerified=True)

    def test_uncertain_controller_retains_its_slot_and_blocks_same_account_worker(self):
        first, _ = self.admitted('uncertain-controller', self.repo, role='chat',
                                subscriptionProfile='team1', workspacePolicy='controller-readonly')
        self.release(first, 'unknown', cleanupVerified=False)
        worker = self.start()
        self.send(worker, self.request('blocked-worker', subscriptionProfile='team1'))
        self.assertEqual(self.receive(worker)['event'], 'queued')
        self.assertIsNone(self.receive(worker, .15))
        next_controller = self.start()
        self.send(next_controller, self.request('next-controller', self.repo, role='chat',
                  subscriptionProfile='team2', workspacePolicy='controller-readonly'))
        self.assertEqual(self.receive(next_controller)['event'], 'queued')
        self.assertIsNone(self.receive(next_controller, .15))

        other_tree = self.root / 'other-worker'
        self.git(self.repo, 'worktree', 'add', '-qb', 'other-worker', str(other_tree))
        other_worker, _ = self.admitted('other-worker', other_tree, subscriptionProfile='team3')
        self.assertIsNone(self.receive(worker, .1))
        self.assertIsNone(self.receive(next_controller, .1))
        cleanup = self.start()
        self.send(cleanup, self.request('uncertain-controller', self.repo, op='update', role='chat',
                  subscriptionProfile='team1', workspacePolicy='controller-readonly',
                  state='cancelled', cleanupVerified=True))
        self.assertEqual(self.receive(cleanup)['event'], 'updated')
        self.assertEqual(cleanup.wait(timeout=3), 0)
        self.assertEqual(self.receive(worker)['event'], 'ready')
        self.assertEqual(self.receive(next_controller)['event'], 'ready')
        self.release(worker, 'completed', cleanupVerified=True)
        self.release(other_worker, 'completed', cleanupVerified=True)
        self.release(next_controller, 'completed', cleanupVerified=True)

    def test_factory_native_uses_owned_folders_and_explicit_role_lanes(self):
        with mock.patch('native_runtime.factory_lease.git', side_effect=AssertionError('native model phases do not require Git')):
            workspace = validate_worktree(str(self.root), 'factory-native')
        self.assertEqual(workspace['workspaceKind'], 'directory')
        self.assertIsNone(workspace['repository'])
        base = {'kind': 'factory-session', 'authMode': 'subscription', 'profile': 'team1',
                'subscriptionProfile': 'team1', 'workspacePolicy': 'factory-native'}
        self.assertEqual(execution_lane({**base, 'role': 'orchestrator'}), 'controller')
        self.assertEqual(execution_lane({**base, 'role': 'worker'}), 'worker')
        self.assertEqual(execution_lane({**base, 'role': 'validator'}), 'worker')
        for role in ('unknown', 'session'):
            with self.subTest(role=role):
                child = self.start()
                self.send(child, self.request(cwd=self.root, role=role, subscriptionProfile='team1',
                                             workspacePolicy='factory-native'))
                self.assertFalse(self.receive(child)['ok'])
                self.assertEqual(child.wait(timeout=3), 2)

    def test_reserved_lane_requires_complete_matching_controller_metadata(self):
        controller = {'kind': 'factory-session', 'authMode': 'subscription', 'profile': 'team1',
                      'subscriptionProfile': 'team1', 'workspacePolicy': 'controller-readonly', 'role': 'chat'}
        self.assertEqual(execution_lane(controller), 'controller')
        for change in ({'kind': 'native-session'}, {'authMode': 'api'}, {'profile': 'team9'},
                       {'subscriptionProfile': 'team2'}, {'subscriptionProfile': None},
                       {'workspacePolicy': None}, {'role': 'worker'}, {'role': 'session'}):
            with self.subTest(change=change):
                self.assertEqual(execution_lane({**controller, **change}), 'worker')
        self.assertEqual(execution_lane({'profile': 'team1', 'role': 'orchestrator'}), 'worker')

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

    def test_eight_seat_ceiling_keeps_controller_progress_and_skips_an_account_blocked_queue_head(self):
        def acquire(suffix, profile, role='worker'):
            child = self.start(max_running=8)
            self.send(child, self.request(suffix, self.root, role=role, subscriptionProfile=profile,
                                          workspacePolicy='factory-native'))
            self.assertEqual(self.receive(child)['event'], 'queued')
            return child

        workers = {}
        for number in range(1, 9):
            child = acquire('seat-' + str(number), 'team' + str(number))
            self.assertEqual(self.receive(child)['event'], 'ready')
            workers[number] = child
        controller = acquire('controller', 'team1', role='orchestrator')
        self.assertEqual(self.receive(controller)['event'], 'ready')
        older = acquire('older-team1', 'team1')
        self.assertIsNone(self.receive(older, .2))
        capacity = report_jobs(self.state, observe_processes=False, max_running=8)['capacity']
        self.assertEqual(capacity['lanes']['worker'], {'limit': 8, 'occupied': 8, 'free': 0, 'waiting': 1, 'waitingBlockedByAccount': 1})
        self.assertEqual(capacity['lanes']['controller']['occupied'], 1)
        self.assertEqual(capacity['accounts']['team1']['workerLane'], 'busy')

        self.release(workers.pop(2), 'completed', cleanupVerified=True)
        self.assertIsNone(self.receive(older, .2))
        younger = acquire('younger-team2', 'team2')
        self.assertEqual(self.receive(younger)['event'], 'ready')
        self.assertIsNone(self.receive(older, .1))

        self.release(workers.pop(1), 'completed', cleanupVerified=True)
        self.release(younger, 'completed', cleanupVerified=True)
        self.assertEqual(self.receive(older)['event'], 'ready')
        for child in [*workers.values(), controller, older]:
            self.release(child, 'completed', cleanupVerified=True)
        settled = report_jobs(self.state, observe_processes=False, max_running=8)['capacity']
        self.assertEqual((settled['lanes']['worker']['occupied'], settled['lanes']['controller']['occupied'], settled['queue']['waiting']), (0, 0, 0))
        self.assertEqual(settled['queue']['recentAdmissions']['count'], 11)

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

    def test_owner_update_frees_account_after_release_acknowledgement_is_missed(self):
        # The bridge stops a helper whose release is not acknowledged in time.
        first, job_id = self.admitted('missed-release', subscriptionProfile='team4')
        self.git(self.repo, 'worktree', 'add', '-qb', 'factory-other', str(self.root / 'other'))
        waiter = self.start()
        self.send(waiter, self.request('next-worker', self.root / 'other', subscriptionProfile='team4'))
        first.terminate()
        first.wait(timeout=3)
        self.assertEqual(self.receive(waiter)['event'], 'queued')
        # Polling has backed off to its ceiling by now, so the release below
        # also shows that a queued waiter is admitted promptly afterwards.
        self.assertIsNone(self.receive(waiter, 1.5))
        self.assertEqual(read_job(self.config, job_id)['state'], 'unknown')

        confirm = self.start()
        self.send(confirm, self.request('missed-release', op='update', subscriptionProfile='team4',
                                        state='completed', cleanupVerified=True))
        self.assertEqual(self.receive(confirm)['event'], 'updated')
        self.assertEqual(confirm.wait(timeout=3), 0)
        job = read_job(self.config, job_id)
        self.assertEqual(job['state'], 'completed')
        self.assertFalse(job['externalCleanupRequired'])
        self.assertEqual(self.receive(waiter, 2.5)['event'], 'ready')
        self.release(waiter, 'completed', cleanupVerified=True)

    def test_invalid_or_sensitive_fields_are_not_persisted_or_echoed(self):
        child, job_id = self.admitted()
        self.send(child, {'op': 'release', 'state': 'idle', 'usage': {'secret-token': 'never-copy-this'}})
        result = self.receive(child)
        self.assertFalse(result['ok'])
        self.assertEqual(child.wait(timeout=3), 2)
        self.assertNotIn('never-copy-this', json.dumps(result))
        self.assertNotIn('never-copy-this', (self.state / 'jobs' / (job_id + '.json')).read_text())
        self.assertTrue(read_job(self.config, job_id)['externalCleanupRequired'])

    def lineage(self, generation, op='acquire', factory='factory-lineage', **extra):
        return {'op': op, 'factorySessionId': factory, 'bridgeSessionId': 'bridge-lineage:g%d' % generation,
                'cwd': str(self.root), 'role': 'orchestrator', 'subscriptionProfile': 'team1',
                'workspacePolicy': 'factory-native', **extra}

    def closed_generation(self, generation=0, checkpoint='checkpoint-a'):
        child = self.start()
        self.send(child, self.lineage(generation))
        self.assertEqual(self.receive(child)['event'], 'queued')
        job_id = self.receive(child)['jobId']
        self.release(child, 'idle', sdkSessionId=checkpoint, cleanupVerified=False)
        # An orderly controller close confirms the session ended without an admitted phase.
        close = self.start()
        self.send(close, self.lineage(generation, op='update', state='cancelled', cleanupVerified=True))
        self.assertEqual(self.receive(close)['event'], 'updated')
        self.assertEqual(close.wait(timeout=3), 0)
        return job_id

    def refused(self, request):
        child = self.start()
        self.send(child, request)
        result = self.receive(child)
        self.assertEqual(child.wait(timeout=3), 2)
        return result

    def jobs_snapshot(self):
        return {path.name: path.read_bytes() for path in sorted((self.state / 'jobs').glob('*.json'))}

    def test_new_generation_continues_a_closed_predecessor_checkpoint(self):
        previous_id = self.closed_generation()
        before = read_job(self.config, previous_id)
        child, job_id = self.admitted(**{key: value for key, value in self.lineage(1, resumeSessionId='checkpoint-a').items()
                                         if key != 'op'})
        self.assertNotEqual(job_id, previous_id)
        self.assertEqual(read_job(self.config, previous_id), before)
        self.release(child, 'idle', sdkSessionId='checkpoint-a', cleanupVerified=False)
        self.assertNotIn('resumeSessionId', read_job(self.config, job_id))

    def test_new_generation_waits_for_unresolved_or_foreign_predecessors(self):
        sleeper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait(timeout=3)))
        foreign = None
        for _ in range(50):
            foreign = process_identity(sleeper.pid)
            if foreign:
                break
            time.sleep(0.05)
        self.assertIsNotNone(foreign)
        dead = dict(process_identity(os.getpid()), start='an exited controller')
        previous_id = self.closed_generation()
        cases = {
            'running': {'state': 'running', 'externalCleanupRequired': True},
            'unknown': {'state': 'unknown', 'externalCleanupRequired': True},
            'waiting_host_exited_owner': {'state': 'waiting_host', 'leaseOwnerIdentity': dead},
            'waiting_host_live_foreign_owner': {'state': 'waiting_host', 'leaseOwnerIdentity': foreign},
            'host_reservation': {'state': 'cancelled', 'hostActionReservation': True},
            'idle_live_foreign_owner': {'state': 'idle', 'leaseOwnerIdentity': foreign},
        }
        original = read_job(self.config, previous_id)
        for name, patch in cases.items():
            with self.subTest(name=name):
                with state_lock(self.config):
                    write_job(self.config, {**original, **patch})
                before = self.jobs_snapshot()
                result = self.refused(self.lineage(1, resumeSessionId='checkpoint-a'))
                self.assertEqual(result, {'ok': False, 'error': 'factory_lease_refused', 'code': 'native_generation',
                                          'reason': 'native_predecessor_unresolved'})
                after = self.jobs_snapshot()
                self.assertEqual(set(after), set(before))
        # The same controller may continue beside its own released phase, for
        # example after a Factory compact handoff to a new session ID.
        with state_lock(self.config):
            write_job(self.config, {**original, 'state': 'waiting_host'})
        child, sibling_id = self.admitted(**{key: value for key, value in self.lineage(0, factory='factory-handoff').items() if key != 'op'})
        self.release(child, 'idle', cleanupVerified=False)
        with state_lock(self.config):
            write_job(self.config, {**read_job(self.config, sibling_id), 'state': 'cancelled'})
        # A released idle phase whose controller exited is not executing.
        with state_lock(self.config):
            write_job(self.config, {**original, 'state': 'idle', 'leaseOwnerIdentity': dead})
        child, _ = self.admitted(**{key: value for key, value in self.lineage(1).items() if key != 'op'})
        self.release(child, 'idle', cleanupVerified=False)

    def test_stale_generation_and_checkpoint_mismatch_are_refused_before_any_write(self):
        self.closed_generation(checkpoint='checkpoint-a')
        before = self.jobs_snapshot()
        mismatch = self.refused(self.lineage(1, resumeSessionId='checkpoint-b'))
        self.assertEqual(mismatch.get('reason'), 'native_checkpoint_mismatch')
        self.assertEqual(self.jobs_snapshot(), before)
        child, _ = self.admitted(**{key: value for key, value in self.lineage(1, resumeSessionId='checkpoint-a').items()
                                    if key != 'op'})
        self.release(child, 'idle', sdkSessionId='checkpoint-a', cleanupVerified=False)
        before = self.jobs_snapshot()
        for request in (self.lineage(0), self.lineage(0, factory='factory-other')):
            with self.subTest(factory=request['factorySessionId']):
                self.assertEqual(self.refused(request).get('reason'), 'stale_native_generation')
                self.assertEqual(self.jobs_snapshot(), before)

    def test_inherited_lease_identity_is_refused_with_a_fixed_category(self):
        job_id = self.closed_generation()
        with state_lock(self.config):
            job = read_job(self.config, job_id)
            job['leaseOwnerIdentity'] = dict(job['leaseOwnerIdentity'], start='an exited controller')
            write_job(self.config, job)
        before = self.jobs_snapshot()
        result = self.refused(self.lineage(0, resumeSessionId='checkpoint-a'))
        self.assertEqual(result, {'ok': False, 'error': 'factory_lease_refused', 'code': 'native_generation',
                                  'reason': 'lease_binding_mismatch'})
        self.assertEqual(self.jobs_snapshot(), before)

    def test_inspect_reports_sanitized_lineage_without_changing_leases(self):
        self.closed_generation(checkpoint='checkpoint-a')
        before = self.jobs_snapshot()
        child = self.start()
        request = {key: value for key, value in self.lineage(0, op='inspect', sdkSessionId='checkpoint-a').items() if key != 'role'}
        self.send(child, request)
        result = self.receive(child)
        self.assertEqual(child.wait(timeout=3), 0)
        self.assertEqual(result['event'], 'inspected')
        [generation] = result['generations']
        self.assertEqual({key: value for key, value in generation.items() if key != 'endedAt'}, {
            'generation': 0, 'state': 'cancelled', 'externalCleanupRequired': False, 'hostActionReservation': False,
            'ownerAlive': True, 'supervisorAlive': False, 'cleanupVerified': True, 'checkpointMatches': True,
            'bindingMatches': True, 'endedBy': 'session_update'})
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(self.jobs_snapshot(), before)
        for patch, field, expected in (({'sdkSessionId': 'checkpoint-b'}, 'checkpointMatches', False),
                                       ({'subscriptionProfile': 'team2'}, 'bindingMatches', False),
                                       ({'factorySessionId': 'factory-other'}, 'bindingMatches', False)):
            with self.subTest(field=field, patch=patch):
                child = self.start()
                self.send(child, {**request, **patch})
                self.assertIs(self.receive(child)['generations'][0][field], expected)
                self.assertEqual(child.wait(timeout=3), 0)
        settlement_request = {key: value for key, value in request.items() if key != 'sdkSessionId'}
        child = self.start()
        self.send(child, settlement_request)
        settlement = self.receive(child)['generations'][0]
        self.assertIsNone(settlement['checkpointMatches'])
        self.assertTrue(settlement['bindingMatches'])
        self.assertTrue(settlement['cleanupVerified'])
        self.assertEqual(child.wait(timeout=3), 0)
        for extra in ({'role': 'orchestrator'}, {'bridgeSessionId': 'bridge-lineage'}, {'sdkSessionId': None}):
            with self.subTest(extra=extra):
                self.assertFalse(self.refused({**request, **extra})['ok'])
        self.assertEqual(self.jobs_snapshot(), before)
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
