import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from native_runtime.core import RuntimeConfig, RuntimeRefused, process_identity, state_lock, write_job
from native_runtime.supervisor import execution_lane, get_job, list_jobs, request_cancel, run_check, run_job


ROOT = Path(__file__).resolve().parents[1]


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        for command in (("init", "-q"), ("config", "user.name", "Fixture"),
                        ("config", "user.email", "fixture@example.invalid")):
            subprocess.run(["git", "-C", str(self.repo), *command], check=True)
        (self.repo / "file.txt").write_text("base\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "fixture"], check=True)
        self.config = RuntimeConfig(self.root / "state", self.root / "workspaces", poll_interval=0.04, cancel_grace=0.4)
        self.processes = []

    def tearDown(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            if proc.stdout:
                proc.stdout.close()
            if proc.stderr:
                proc.stderr.close()
        self.temp.cleanup()

    def launch(self, profile="team1", sleep=0.3, max_running=2, timeout=20, child=None):
        code = """
import os,sys
from pathlib import Path
from native_runtime.core import RuntimeConfig
from native_runtime.supervisor import run_job
c=RuntimeConfig(Path(sys.argv[1]),Path(sys.argv[2]),max_running=int(sys.argv[5]),poll_interval=.04,cancel_grace=.4)
script=sys.argv[7]
r=run_job(c,sys.argv[4],sys.argv[3],lambda job:([sys.executable,'-c',script],dict(os.environ)),timeout_seconds=float(sys.argv[6]))
print('RESULT='+r['id'],flush=True)
"""
        child = child or "import time;from pathlib import Path;Path('owned.txt').write_text('job');time.sleep(%s)" % sleep
        env = dict(os.environ, PYTHONPATH=str(ROOT))
        proc = subprocess.Popen([sys.executable, "-c", code, str(self.config.state_root), str(self.config.workspace_root),
                                 str(self.repo), profile, str(max_running), str(timeout), child],
                                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(proc)
        return proc

    def wait_job(self, predicate, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            jobs = list_jobs(self.config)
            for job in jobs:
                if predicate(job):
                    return job
            for proc in self.processes:
                if proc.poll() not in (None, 0):
                    self.fail("Supervisor subprocess failed: " + proc.stderr.read())
            time.sleep(0.04)
        self.fail("Expected job state not reached: " + repr(list_jobs(self.config)))

    def wait_process(self, proc):
        out, err = proc.communicate(timeout=12)
        self.assertEqual(proc.returncode, 0, err)
        return out

    def test_execution_metadata_privacy_and_resume(self):
        def builder(job):
            return [sys.executable, "-c", "from pathlib import Path;Path('owned.txt').write_text('success')"], dict(os.environ)
        job = run_job(self.config, "team1", self.repo, builder,
                      requested={"model": "fixture", "effort": "medium"})
        self.assertEqual(job["state"], "completed")
        self.assertTrue(job["cleanupVerified"])
        self.assertEqual((Path(job["worktree"]) / "owned.txt").read_text(), "success")
        self.assertFalse((self.repo / "owned.txt").exists())
        saved = (self.config.state_root / "jobs" / (job["id"] + ".json")).read_text()
        self.assertNotIn("write_text", saved)
        self.assertEqual((self.config.state_root / "jobs" / (job["id"] + ".json")).stat().st_mode & 0o777, 0o600)
        resumed = run_job(self.config, "team1", self.repo, builder, job_id=job["id"])
        self.assertEqual(resumed["sessionId"], job["sessionId"])
        self.assertEqual(resumed["worktree"], job["worktree"])
        self.assertEqual(resumed["attempt"], 2)
        with self.assertRaises(RuntimeRefused):
            run_job(self.config, "team2", self.repo, builder, job_id=job["id"])

    def test_on_created_announces_new_and_resumed_job_before_execution(self):
        announced = []
        def announce(job):
            self.assertEqual(job["state"], "waiting_slot")
            self.assertNotIn("childIdentity", job)
            self.assertEqual(get_job(self.config, job["id"])["state"], "waiting_slot")
            announced.append(job)
        def builder(job):
            self.assertEqual(announced[-1]["id"], job["id"])
            return [sys.executable, "-c", "pass"], dict(os.environ)
        job = run_job(self.config, "team1", self.repo, builder, on_created=announce)
        run_job(self.config, "team1", self.repo, builder, job_id=job["id"], on_created=announce)
        self.assertEqual(len(announced), 2)
        self.assertFalse(announced[0]["resume"])
        self.assertTrue(announced[1]["resume"])

    def test_on_created_failure_records_terminal_without_starting_child(self):
        def announce(job):
            raise RuntimeError("fixture announcement failure")
        with self.assertRaises(RuntimeError):
            run_job(self.config, "team1", self.repo,
                    lambda _: self.fail("must not execute"), on_created=announce)
        job = list_jobs(self.config)[0]
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["reason"], "job_announcement_failed")
        self.assertNotIn("childIdentity", job)

    def test_same_profile_queues_and_cancel_starts_next(self):
        first_proc = self.launch(sleep=8)
        first = self.wait_job(lambda item: item["state"] == "running")
        second_proc = self.launch(sleep=0.1)
        second = self.wait_job(lambda item: item["id"] != first["id"] and item["state"] == "waiting_slot")
        self.assertNotIn("startedAt", second)
        request_cancel(self.config, first["id"])
        self.wait_process(first_proc)
        self.wait_process(second_proc)
        first = get_job(self.config, first["id"])
        second = get_job(self.config, second["id"])
        self.assertEqual(first["state"], "cancelled")
        self.assertEqual(second["state"], "completed")
        self.assertGreaterEqual(second["admittedAt"], first["endedAt"])
        self.assertNotEqual(first["worktree"], second["worktree"])

    def test_global_limit_queues_different_profiles(self):
        first_proc = self.launch(profile="team1", sleep=8, max_running=1)
        first = self.wait_job(lambda item: item["state"] == "running")
        second_proc = self.launch(profile="team2", sleep=0.1, max_running=1)
        second = self.wait_job(lambda item: item["id"] != first["id"] and item["state"] == "waiting_slot")
        request_cancel(self.config, first["id"])
        self.wait_process(first_proc)
        self.wait_process(second_proc)
        self.assertEqual(get_job(self.config, second["id"])["state"], "completed")

    def test_distinct_profiles_can_overlap_up_to_global_limit(self):
        first_proc = self.launch(profile="team1", sleep=8)
        first = self.wait_job(lambda item: item["state"] == "running")
        second_proc = self.launch(profile="team2", sleep=8)
        second = self.wait_job(lambda item: item["id"] != first["id"] and item["state"] == "running")
        request_cancel(self.config, first["id"])
        request_cancel(self.config, second["id"])
        self.wait_process(first_proc)
        self.wait_process(second_proc)

    def test_factory_controller_runs_while_native_workers_fill_their_capacity(self):
        first_proc = self.launch(profile='team1', sleep=8)
        first = self.wait_job(lambda item: item['state'] == 'running')
        second_proc = self.launch(profile='team2', sleep=8)
        second = self.wait_job(lambda item: item['id'] != first['id'] and item['state'] == 'running')
        third_proc = self.launch(profile='team3', sleep=0.1)
        third = self.wait_job(lambda item: item['id'] not in (first['id'], second['id'])
                              and item['state'] == 'waiting_slot')
        controller = subprocess.Popen(
            [sys.executable, '-m', 'native_runtime.factory_lease', '--state-root', str(self.config.state_root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0, env=dict(os.environ, PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE='1'))
        self.processes.append(controller)
        try:
            request = {'op': 'acquire', 'factorySessionId': 'native-controller',
                       'bridgeSessionId': 'native-controller-phase', 'cwd': str(self.repo),
                       'role': 'orchestrator', 'subscriptionProfile': 'team1',
                       'workspacePolicy': 'controller-readonly'}
            controller.stdin.write((json.dumps(request) + '\n').encode())
            controller.stdin.flush()
            self.assertTrue(select.select([controller.stdout], [], [], 3)[0])
            self.assertEqual(json.loads(controller.stdout.readline())['event'], 'queued')
            self.assertTrue(select.select([controller.stdout], [], [], 3)[0])
            self.assertEqual(json.loads(controller.stdout.readline())['event'], 'ready')
            jobs = list_jobs(self.config)
            occupied = [job for job in jobs if job['state'] in ('starting', 'running')]
            self.assertEqual(sum(execution_lane(job) == 'worker' for job in occupied), 2)
            self.assertEqual(sum(execution_lane(job) == 'controller' for job in occupied), 1)
            self.assertEqual(get_job(self.config, third['id'])['state'], 'waiting_slot')

            request_cancel(self.config, first['id'])
            self.wait_process(first_proc)
            self.wait_process(third_proc)
            self.assertEqual(get_job(self.config, third['id'])['state'], 'completed')
            self.assertEqual(get_job(self.config, second['id'])['state'], 'running')
            controller.stdin.write((json.dumps({'op': 'release', 'state': 'completed', 'cleanupVerified': True}) + '\n').encode())
            controller.stdin.flush()
            self.assertTrue(select.select([controller.stdout], [], [], 3)[0])
            self.assertEqual(json.loads(controller.stdout.readline())['event'], 'released')
            self.wait_process(controller)
        finally:
            controller.stdin.close()
            request_cancel(self.config, second['id'])
            self.wait_process(second_proc)

    def test_deadline_terminates_owned_process_without_touching_unrelated(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        self.processes.append(unrelated)
        proc = self.launch(sleep=30, timeout=1)
        self.wait_process(proc)
        job = list_jobs(self.config)[0]
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["reason"], "deadline_exceeded")
        self.assertTrue(job["cleanupVerified"])
        self.assertIsNone(unrelated.poll())

    def test_child_descendant_is_stopped_before_slot_release(self):
        script = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);time.sleep(30)"
        proc = self.launch(timeout=1, child=script)
        job = self.wait_job(lambda item: item["state"] == "running" and len(item.get("ownedProcesses", [])) >= 2)
        self.wait_process(proc)
        final = get_job(self.config, job["id"])
        self.assertTrue(final["cleanupVerified"])
        self.assertTrue(all(process_identity(item["pid"]) != item for item in final["ownedProcesses"]))

    def test_observed_detached_child_is_stopped(self):
        script = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True);time.sleep(30)"
        proc = self.launch(timeout=2, child=script)
        job = self.wait_job(lambda item: item["state"] == "running" and any(
            value["pgid"] != item["processGroup"] for value in item.get("ownedProcesses", [])))
        detached = next(value for value in job["ownedProcesses"] if value["pgid"] != job["processGroup"])
        request_cancel(self.config, job["id"])
        self.wait_process(proc)
        self.assertTrue(get_job(self.config, job["id"])["cleanupVerified"])
        self.assertNotEqual(process_identity(detached["pid"]), detached)

    def test_crash_between_spawn_and_persist_never_executes_task(self):
        marker = self.root / "spawned.json"
        touched = self.root / "must-not-run"
        code = """
import os,sys,json,time
from pathlib import Path
from native_runtime.core import RuntimeConfig
import native_runtime.supervisor as s
c=RuntimeConfig(Path(sys.argv[1]),Path(sys.argv[2]),poll_interval=.04,cancel_grace=.4)
original=s._persist
def injected(config,job,**fields):
    if job.get('childGate')=='waiting_for_durable_identity':
        Path(sys.argv[4]).write_text(json.dumps(job))
        time.sleep(30)
    return original(config,job,**fields)
s._persist=injected
s.run_job(c,'team1',sys.argv[3],lambda _:([sys.executable,'-c',"from pathlib import Path;Path("+repr(sys.argv[5])+").touch()"],dict(os.environ)))
"""
        proc = subprocess.Popen([sys.executable, "-c", code, str(self.config.state_root),
                                 str(self.config.workspace_root), str(self.repo), str(marker), str(touched)],
                                env=dict(os.environ, PYTHONPATH=str(ROOT)), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        self.processes.append(proc)
        until = time.monotonic() + 8
        while not marker.exists() and time.monotonic() < until:
            time.sleep(0.04)
        self.assertTrue(marker.exists())
        gated = json.loads(marker.read_text())
        proc.kill()
        proc.wait(timeout=5)
        until = time.monotonic() + 5
        while process_identity(gated["processGroup"]) is not None and time.monotonic() < until:
            time.sleep(0.04)
        self.assertFalse(touched.exists())
        self.assertIsNone(process_identity(gated["processGroup"]))
        self.assertEqual(get_job(self.config, list_jobs(self.config)[0]["id"])["state"], "interrupted")

    def test_child_identity_observation_failure_keeps_cleanup_evidence(self):
        import native_runtime.supervisor as supervisor
        original = supervisor.process_identity
        def identity(pid):
            if pid != os.getpid():
                raise RuntimeRefused("fixture unavailable")
            return original(pid)
        with mock.patch.object(supervisor, "process_identity", side_effect=identity):
            with self.assertRaises(RuntimeRefused):
                run_job(self.config, "team1", self.repo,
                        lambda _: ([sys.executable, "-c", "raise Exception('must not execute')"], dict(os.environ)))
        saved = list_jobs(self.config)[0]
        self.assertEqual(saved["state"], "failed")
        self.assertTrue(saved["cleanupVerified"])

    def test_cancel_queued_does_not_start_child(self):
        one_proc = self.launch(sleep=8)
        one = self.wait_job(lambda item: item["state"] == "running")
        two_proc = self.launch(sleep=0.1)
        two = self.wait_job(lambda item: item["id"] != one["id"] and item["state"] == "waiting_slot")
        request_cancel(self.config, two["id"])
        self.wait_process(two_proc)
        self.assertNotIn("childIdentity", get_job(self.config, two["id"]))
        request_cancel(self.config, one["id"])
        self.wait_process(one_proc)

    def test_stale_pid_identity_does_not_claim_live_supervisor(self):
        job = run_job(self.config, "team1", self.repo,
                      lambda _: ([sys.executable, "-c", "pass"], dict(os.environ)))
        job.update(state="running", supervisorIdentity=dict(process_identity(os.getpid()), start="wrong-start"),
                   childIdentity=None, ownedProcesses=[], processGroup=None)
        with state_lock(self.config):
            write_job(self.config, job)
        reconciled = list_jobs(self.config)[0]
        self.assertEqual(reconciled["state"], "interrupted")

    def test_orphaned_live_child_keeps_slot(self):
        proc = self.launch(sleep=30)
        job = self.wait_job(lambda item: item["state"] == "running")
        proc.kill()
        proc.wait(timeout=4)
        orphan = next(item for item in list_jobs(self.config) if item["id"] == job["id"])
        self.assertEqual(orphan["state"], "orphaned")
        # Explicit test cleanup uses the observed owned group, not production recovery.
        os.killpg(job["processGroup"], signal.SIGTERM)
        self.wait_job(lambda item: item["id"] == job["id"] and item["state"] == "interrupted")

    def test_check_records_execution_and_preserves_main_job_outcome(self):
        job = run_job(self.config, "team1", self.repo,
                      lambda _: ([sys.executable, "-c", "pass"], dict(os.environ)))
        check = run_check(self.config, job["id"], "fixture-check",
                          [sys.executable, "-c", "from pathlib import Path;assert Path('file.txt').read_text()=='base\\n'"])
        self.assertTrue(check["executed"])
        self.assertEqual(check["exitCode"], 0)
        self.assertEqual(check["state"], "completed")
        self.assertEqual(get_job(self.config, job["id"])["state"], "completed")
        receipt = self.config.state_root / "checks" / job["id"] / (check["id"] + ".json")
        self.assertEqual(json.loads(receipt.read_text())["jobId"], job["id"])


if __name__ == "__main__":
    unittest.main()
