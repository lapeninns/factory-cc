import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_runtime.telemetry import extract_usage
from native_runtime.reporting import capacity_view, report_jobs
from datetime import datetime, timezone
from native_runtime.core import RuntimeRefused


SESSION = "10000000-0000-4000-8000-000000000001"
OTHER = "10000000-0000-4000-8000-000000000002"


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = self.root / "profile"
        self.worktree = self.root / "workspace"
        self.project = self.config / "projects" / str(self.worktree).replace("/", "-")
        self.project.mkdir(parents=True)
        self.job = {"id": "job-one", "profile": "team1", "kind": "native-session", "sessionId": SESSION,
                    "configDir": str(self.config), "worktree": str(self.worktree),
                    "state": "completed", "requested": {"model": "claude-opus-5-5", "effort": "medium", "ultracode": True}}

    def record(self, mid="msg_1", tokens=10, session=SESSION, **extra):
        result = {"type": "assistant", "sessionId": session, "effort": "medium", "version": "2.1.316",
                  "message": {"id": mid, "model": "claude-opus-5-5", "content": [{"text": "SECRET PROMPT"}],
                              "usage": {"input_tokens": tokens, "output_tokens": 2,
                                        "cache_read_input_tokens": 3, "cache_creation_input_tokens": 4}}}
        result.update(extra)
        return result

    def write_jsonl(self, path, records, tail=b""):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"".join(json.dumps(record).encode() + b"\n" for record in records) + tail)

    def write_root(self, records, tail=b""):
        self.write_jsonl(self.project / (SESSION + ".jsonl"), records, tail)

    def test_deduplicates_repeated_and_partial_message_snapshots(self):
        self.write_root([self.record(tokens=5), self.record(tokens=10), self.record(tokens=10), self.record("msg_2", 20)])
        result = extract_usage(self.job)
        self.assertEqual(result["tokens"], {"input": 30, "output": 4, "cacheRead": 6, "cacheCreation": 8, "total": 48})
        self.assertEqual(result["deduplicatedMessages"], 2)
        self.assertEqual(result["observedEfforts"], ["medium"])
        self.assertEqual(result["observedModels"], ["claude-opus-5-5"])
        self.assertEqual(result["observedCliVersions"], ["2.1.316"])
        self.assertIsNone(result["observedUltracode"])
        self.assertNotIn("SECRET", json.dumps(result))

    def test_counts_exact_session_children_and_workflow_journal_separately(self):
        self.write_root([self.record()])
        child = self.project / SESSION / "subagents" / "workflows" / "wf_example" / "agent-child.jsonl"
        self.write_jsonl(child, [self.record("msg_2", 20), self.record("msg_1")])
        self.write_jsonl(child.parent / "journal.jsonl", [
            {"type": "started", "agentId": "a1", "label": "SECRET LABEL"},
            {"type": "result", "agentId": "a1", "result": "SECRET RESULT"},
            {"type": "result", "agentId": "a1", "result": "SECRET RESULT"},
        ])
        state = self.project / SESSION / "workflows" / "wf_example.json"
        state.parent.mkdir()
        state.write_text(json.dumps({"runId": "wf_example", "status": "completed", "agentCount": 1,
                                     "totalTokens": 9999, "totalToolCalls": 0, "defaultModel": "claude-opus-5-5",
                                     "script": "SECRET SCRIPT", "logs": ["SECRET LOG"]}))
        result = extract_usage(self.job)
        self.assertEqual(result["tokens"]["total"], 48)
        self.assertFalse(result["workflowTokenSummariesAddedToTokens"])
        self.assertEqual(result["workflows"][0]["totalTokens"], 9999)
        self.assertEqual(result["workflows"][0]["journal"], {"agentsStarted": 1, "agentResults": 1, "agentErrors": 0})
        self.assertNotIn("SECRET", json.dumps(result))

    def test_child_result_does_not_infer_workflow_success(self):
        journal = self.project / SESSION / "subagents" / "workflows" / "wf_only" / "journal.jsonl"
        self.write_jsonl(journal, [{"type": "result", "agentId": "a1", "result": "SECRET"}])
        result = extract_usage(self.job)
        self.assertIsNone(result["tokens"])
        self.assertEqual(result["workflows"][0]["state"], "unknown")
        self.assertIsNone(result["remainingSubscriptionAllowance"])
        self.assertIsNone(result["billedCostUsd"])

    def test_mismatched_session_and_other_session_paths_are_ignored(self):
        self.write_root([self.record(session=OTHER), self.record()])
        self.write_jsonl(self.project / (OTHER + ".jsonl"), [self.record("msg_other", 1000, OTHER)])
        self.write_jsonl(self.project / OTHER / "subagents" / "agent.jsonl", [self.record("msg_other2", 1000, OTHER)])
        result = extract_usage(self.job)
        self.assertEqual(result["deduplicatedMessages"], 1)
        self.assertEqual(result["tokens"]["total"], 19)

    def test_incomplete_malformed_and_missing_id_are_reported_without_raw_content(self):
        item = self.record()
        item["message"].pop("id")
        self.write_root([self.record(), item], b'not json\n{"SECRET_INCOMPLETE":')
        result = extract_usage(self.job)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["coverage"]["malformedRecords"], 1)
        self.assertEqual(result["coverage"]["incompleteRecords"], 1)
        self.assertEqual(result["coverage"]["messagesWithoutId"], 1)
        self.assertEqual(result["deduplicatedMessages"], 1)
        self.assertNotIn("SECRET", json.dumps(result))

    def test_symlinked_transcripts_children_and_profile_are_not_followed(self):
        outside = self.root / "outside.jsonl"
        self.write_jsonl(outside, [self.record()])
        (self.project / (SESSION + ".jsonl")).symlink_to(outside)
        base = self.project / SESSION / "subagents"
        base.mkdir(parents=True)
        (base / "agent.jsonl").symlink_to(outside)
        self.assertFalse(extract_usage(self.job)["available"])
        link = self.root / "profile-link"
        link.symlink_to(self.config, target_is_directory=True)
        self.job["configDir"] = str(link)
        self.assertFalse(extract_usage(self.job)["available"])

    def test_invalid_identifiers_and_relative_paths_cannot_expand_scope(self):
        self.write_root([self.record()])
        for value in ("../../secrets", "not-a-uuid", SESSION.upper()):
            if value == SESSION:
                continue
            bad = dict(self.job, sessionId=value)
            self.assertFalse(extract_usage(bad)["available"])
        self.assertFalse(extract_usage(dict(self.job, configDir="profile"))["available"])
        self.assertFalse(extract_usage(dict(self.job, worktree="relative"))["available"])

    def test_bounds_files_and_bytes_and_marks_partial(self):
        self.write_root([self.record(), self.record("msg_2")])
        with mock.patch("native_runtime.telemetry.MAX_FILE_BYTES", 40):
            result = extract_usage(self.job)
        self.assertTrue(result["coverage"]["boundedReadLimitReached"])
        self.assertEqual(result["status"], "partial")
        self.assertIsNone(result["tokens"])

    def test_structured_error_categories_are_counted_without_error_text(self):
        self.write_root([
            {"type": "system", "subtype": "api_error", "uuid": "error1", "error": {"type": "rate_limit_error", "message": "SECRET"}},
            {"type": "system", "subtype": "api_error", "uuid": "error1", "error": {"status": 429}},
            {"type": "assistant", "isApiErrorMessage": True, "uuid": "error2", "message": {"content": "SECRET"}},
            {"type": "user", "content": "rate_limit_error SECRET"},
        ])
        result = extract_usage(self.job)
        self.assertEqual(result["apiErrors"], 1)
        self.assertEqual(result["rateLimitErrors"], 1)
        self.assertNotIn("SECRET", json.dumps(result))

    def test_unavailable_is_unknown_not_zero_usage_or_success(self):
        result = extract_usage(self.job)
        self.assertFalse(result["available"])
        self.assertIsNone(result["tokens"])
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["workflows"], [])

    def test_report_only_counts_executed_checks_and_keeps_requested_separate(self):
        self.write_root([self.record()])
        state = self.root / "state"
        (state / "jobs").mkdir(parents=True)
        job = dict(self.job, startedAt="2026-11-02T12:00:00+00:00", endedAt="2026-11-02T12:01:00+00:00",
                   updatedAt="2026-11-02T12:01:00+00:00", secret="SECRET", prompt="SECRET PROMPT")
        (state / "jobs" / "job-one.json").write_text(json.dumps(job))
        (state / "jobs" / "check-child.json").write_text(json.dumps({"id": "check-child", "kind": "executed-check"}))
        checks = state / "checks" / "job-one"
        checks.mkdir(parents=True)
        valid = {"kind": "executed-check", "executed": True, "jobId": "job-one", "name": "unit", "exitCode": 0,
                 "worktree": str(self.worktree), "startedAt": "2026-11-02T12:00:00+00:00", "endedAt": "2026-11-02T12:00:01+00:00",
                 "head": "abc123", "command": "SECRET COMMAND", "output": "SECRET OUTPUT"}
        for name, changes in (("pass", {}), ("fail", {"exitCode": 1}), ("not-executed", {"executed": False}),
                              ("wrong-job", {"jobId": "job-other"}), ("wrong-worktree", {"worktree": "/elsewhere"}),
                              ("invalid-exit", {"exitCode": True}), ("invalid-time", {"endedAt": "invalid"})):
            (checks / (name + ".json")).write_text(json.dumps(dict(valid, **changes)))
        report = report_jobs(state)
        self.assertEqual(len(report["jobs"]), 1)
        self.assertEqual(report["totals"], {"jobs": 1, "recordedChecksPassed": 1, "recordedChecksFailed": 1,
                                            "reportedTokens": 19, "jobsWithTokenEvidence": 1})
        item = report["jobs"][0]
        self.assertEqual(item["durationSeconds"], 60)
        self.assertEqual(item["requested"]["effort"], "medium")
        self.assertEqual(item["telemetry"]["observedEfforts"], ["medium"])
        self.assertFalse(item["quality"]["deliveryVerified"])
        self.assertNotIn("SECRET", json.dumps(report))
        self.assertNotIn(str(self.config), json.dumps(report))

    def test_capacity_view_reports_lanes_accounts_exclusions_and_queue_delay(self):
        controller = {"id": "controller", "kind": "factory-session", "authMode": "subscription", "profile": "team1",
                      "subscriptionProfile": "team1", "workspacePolicy": "factory-native", "role": "orchestrator",
                      "state": "running", "queuedAt": "2026-11-09T12:00:00+00:00", "admittedAt": "2026-11-09T12:00:02+00:00"}
        worker = {"id": "worker-1", "kind": "factory-session", "authMode": "subscription", "profile": "team1",
                  "subscriptionProfile": "team1", "workspacePolicy": "factory-native", "role": "worker", "state": "running",
                  "queuedAt": "2026-11-09T12:00:00+00:00", "admittedAt": "2026-11-09T12:00:10+00:00", "prompt": "SECRET PROMPT"}
        uncertain = dict(worker, id="worker-2", profile="team2", subscriptionProfile="team2", state="unknown")
        settled = dict(worker, id="worker-3", profile="team3", subscriptionProfile="team3", state="completed",
                       admittedAt="2026-11-09T12:00:04+00:00")
        waiting_busy = dict(worker, id="worker-4", state="waiting_slot", queuedAt="2026-11-09T12:59:30+00:00")
        waiting_free = dict(worker, id="worker-5", profile="team4", subscriptionProfile="team4", state="waiting_slot",
                            queuedAt="2026-11-09T12:59:50+00:00")
        waiting_excluded = dict(worker, id="worker-6", profile="team2", subscriptionProfile="team2", role="orchestrator",
                                state="waiting_slot", queuedAt="2026-11-09T12:59:55+00:00")
        jobs = [controller, worker, uncertain, settled, waiting_busy, waiting_free, waiting_excluded]
        at = datetime(2026, 11, 9, 13, 0, tzinfo=timezone.utc).timestamp()

        unknown_limit = capacity_view(jobs, at=at)
        self.assertIsNone(unknown_limit["lanes"]["worker"]["limit"])
        self.assertIsNone(unknown_limit["lanes"]["worker"]["free"])
        self.assertTrue(unknown_limit["workerLimitSource"].startswith("unknown"))

        view = capacity_view(jobs, max_running=8, at=at)
        self.assertEqual(view["lanes"]["controller"], {"limit": 1, "occupied": 1, "free": 0, "waiting": 1, "waitingBlockedByAccount": 1})
        self.assertEqual(view["lanes"]["worker"], {"limit": 8, "occupied": 2, "free": 6, "waiting": 2, "waitingBlockedByAccount": 1})
        self.assertEqual(view["accounts"]["team1"], {"waiting": 1, "uncertain": 0, "controllerOccupied": 1, "controllerLane": "busy",
                                                     "workerOccupied": 1, "workerLane": "busy"})
        self.assertEqual(view["accounts"]["team2"]["controllerLane"], "excluded_until_cleanup_verified")
        self.assertEqual(view["accounts"]["team2"]["workerLane"], "excluded_until_cleanup_verified")
        self.assertEqual(view["accounts"]["team3"]["workerLane"], "free")
        self.assertEqual(sorted(view["accounts"]), ["team" + str(number) for number in range(1, 9)])
        self.assertEqual(view["queue"], {"waiting": 3, "oldestWaitSeconds": 30.0,
                                         "recentAdmissions": {"count": 4, "medianDelaySeconds": 10.0, "maxDelaySeconds": 10.0}})
        self.assertIn("remaining provider allowance", view["meaning"])
        self.assertNotIn("SECRET", json.dumps(view))
        with self.assertRaises(RuntimeRefused):
            capacity_view(jobs, max_running=9)

    def test_capacity_covers_every_retained_record_beyond_the_detail_cap(self):
        state = self.root / "state"
        jobs = state / "jobs"
        jobs.mkdir(parents=True)
        for number in range(1000):
            name = "job-%04d" % number
            (jobs / (name + ".json")).write_text(json.dumps({"id": name, "profile": "team1", "kind": "native-session", "state": "completed"}))
        late = {"id": "job-1000", "kind": "factory-session", "authMode": "subscription", "profile": "team2",
                "subscriptionProfile": "team2", "workspacePolicy": "factory-native", "role": "worker", "state": "unknown"}
        (jobs / "job-1000.json").write_text(json.dumps(late))
        report = report_jobs(state, observe_processes=False, max_running=8)
        self.assertEqual(len(report["jobs"]), 1000)
        self.assertIn("Job report limited to 1000 records.", report["warnings"])
        capacity = report["capacity"]
        self.assertTrue(capacity["complete"])
        self.assertEqual(capacity["records"], 1001)
        self.assertEqual(capacity["lanes"]["worker"]["occupied"], 1)
        self.assertEqual(capacity["accounts"]["team2"]["workerLane"], "excluded_until_cleanup_verified")
        self.assertEqual(capacity["accounts"]["team2"]["controllerLane"], "excluded_until_cleanup_verified")

        (jobs / "job-0500.json").write_text("{not json")
        unknown = report_jobs(state, observe_processes=False, max_running=8)["capacity"]
        self.assertFalse(unknown["complete"])
        self.assertEqual(unknown["unreadableRecords"], 1)
        self.assertIsNone(unknown["lanes"])
        self.assertIsNone(unknown["accounts"])
        self.assertIsNone(unknown["queue"])

    def test_report_rejects_symlinked_state(self):
        state = self.root / "state"
        state.mkdir()
        link = self.root / "state-link"
        link.symlink_to(state)
        result = report_jobs(link)
        self.assertEqual(result["jobs"], [])
        self.assertTrue(result["warnings"])

    def test_core_metadata_and_returncode_are_reported(self):
        self.write_root([self.record()])
        state = self.root / "state"
        (state / "jobs").mkdir(parents=True)
        job = dict(self.job, metadata={"configDir": str(self.config)}, returnCode=23, sourceCommit="abcd1234")
        del job["configDir"]
        (state / "jobs" / "job-one.json").write_text(json.dumps(job))
        result = report_jobs(state, observe_processes=False)["jobs"][0]
        self.assertEqual(result["recordedExitCode"], 23)
        self.assertEqual(result["sourceCommit"], "abcd1234")
        self.assertEqual(result["telemetry"]["deduplicatedMessages"], 1)
        self.assertIsNone(result["processObservation"]["ownerAlive"])
        self.assertIsNone(result["processObservation"]["ownedProcessCount"])

    def test_process_liveness_matches_full_identity_without_changing_recorded_state(self):
        state = self.root / "state"
        (state / "jobs").mkdir(parents=True)
        owner = {"pid": 123, "pgid": 99, "uid": os.getuid(), "start": "owner start"}
        child = {"pid": 124, "pgid": 124, "uid": os.getuid(), "start": "child start"}
        job = dict(self.job, state="cleanup_blocked", supervisorIdentity=owner,
                   childIdentity=child, ownedProcesses=[child, child])
        file = state / "jobs" / "job-one.json"
        file.write_text(json.dumps(job))
        with mock.patch("native_runtime.reporting.process_table", return_value={123: owner, 124: child}):
            result = report_jobs(state)["jobs"][0]
        self.assertEqual(result["recordedState"], "cleanup_blocked")
        self.assertEqual(result["state"], "cleanup_blocked")
        self.assertEqual(result["processObservation"], {"ownerAlive": True, "childAlive": True,
                                                        "ownedProcessCount": 1, "state": "owner_and_children"})
        with mock.patch("native_runtime.reporting.process_table", return_value={124: child}):
            result = report_jobs(state)["jobs"][0]
        self.assertFalse(result["processObservation"]["ownerAlive"])
        self.assertEqual(result["processObservation"]["state"], "owned_children_without_owner")
        with mock.patch("native_runtime.reporting.process_table", return_value={123: dict(owner, start="reused pid")}):
            result = report_jobs(state)["jobs"][0]
        self.assertEqual(result["recordedState"], "cleanup_blocked")
        self.assertEqual(result["processObservation"]["ownedProcessCount"], 0)
        self.assertFalse(result["processObservation"]["ownerAlive"])

    def test_process_snapshot_failure_keeps_orphaned_and_unknown_liveness(self):
        state = self.root / "state"
        (state / "jobs").mkdir(parents=True)
        (state / "jobs" / "job-one.json").write_text(json.dumps(dict(self.job, state="orphaned")))
        with mock.patch("native_runtime.reporting.process_table", side_effect=RuntimeRefused("not observable")):
            result = report_jobs(state)
        self.assertFalse(result["processSnapshotAvailable"])
        self.assertTrue(result["warnings"])
        self.assertEqual(result["jobs"][0]["recordedState"], "orphaned")
        self.assertIsNone(result["jobs"][0]["processObservation"]["ownedProcessCount"])
        self.assertIsNone(result["jobs"][0]["processObservation"]["ownerAlive"])

    def test_factory_phase_usage_stays_separate_from_native_totals(self):
        self.write_root([self.record()])
        state = self.root / "state"
        (state / "jobs").mkdir(parents=True)
        (state / "jobs" / "job-one.json").write_text(json.dumps(self.job))
        factory = {"id": "factory-one", "kind": "factory-session", "profile": "factory-api",
                   "state": "waiting_host", "role": "worker", "attempt": 2,
                   "sessionId": OTHER, "worktree": str(self.worktree),
                   "requested": {"model": "claude-opus-5-5", "effort": "medium", "ultracode": True},
                   "reportedPhaseUsage": {"input_tokens": 100, "output_tokens": 50},
                   "cleanupVerified": None, "reportedCleanupVerified": False,
                   "cleanupEvidenceSource": "bridge", "externalCleanupRequired": False}
        (state / "jobs" / "factory-one.json").write_text(json.dumps(factory))
        report = report_jobs(state, observe_processes=False)
        self.assertEqual(report["totals"]["jobs"], 2)
        self.assertEqual(report["totals"]["reportedTokens"], 19)
        self.assertEqual(report["totals"]["jobsWithTokenEvidence"], 1)
        item = next(job for job in report["jobs"] if job["id"] == "factory-one")
        self.assertEqual(item["recordedState"], "waiting_host")
        self.assertEqual(item["kind"], "factory-session")
        self.assertIsNone(item["telemetry"]["tokens"])
        self.assertEqual(item["telemetry"]["status"], "bridge_report_only")
        phase = item["telemetry"]["bridgeReportedPhaseUsage"]
        self.assertEqual(phase["counters"], {"input_tokens": 100, "output_tokens": 50})
        self.assertEqual(phase["phase"], 2)
        self.assertFalse(phase["includedInTranscriptTokens"])
        self.assertFalse(phase["independentlyReconciled"])
        self.assertIsNone(item["cleanupObservation"]["independentlyVerified"])
        self.assertFalse(item["cleanupObservation"]["bridgeReportedVerified"])
        self.assertEqual(item["quality"]["recordedPasses"], 0)
        self.assertFalse(item["quality"]["deliveryVerified"])

    def test_factory_lease_identity_is_observed_without_sdk_process_authority(self):
        state = self.root / "state"
        (state / "jobs").mkdir(parents=True)
        bridge = {"pid": 123, "pgid": 123, "uid": os.getuid(), "start": "bridge start"}
        helper = {"pid": 124, "pgid": 123, "uid": os.getuid(), "start": "helper start"}
        factory = {"id": "factory-one", "kind": "factory-session", "profile": "factory-api",
                   "state": "idle", "leaseOwnerIdentity": bridge, "supervisorIdentity": helper,
                   "ownedProcesses": [bridge], "cleanupVerified": True,
                   "reportedCleanupVerified": True, "cleanupEvidenceSource": "bridge"}
        path = state / "jobs" / "factory-one.json"
        path.write_text(json.dumps(factory))
        before = path.read_bytes()
        with mock.patch("native_runtime.reporting.process_table", return_value={123: bridge, 124: helper}):
            report = report_jobs(state)
        self.assertEqual(before, path.read_bytes())
        item = report["jobs"][0]
        self.assertEqual(item["state"], "idle")
        self.assertTrue(item["processObservation"]["leaseOwnerAlive"])
        self.assertTrue(item["processObservation"]["ownerAlive"])
        self.assertIsNone(item["processObservation"]["ownedProcessCount"])
        self.assertIsNone(item["processObservation"]["childAlive"])
        self.assertIsNone(item["cleanupObservation"]["independentlyVerified"])
        self.assertTrue(item["cleanupObservation"]["bridgeReportedVerified"])
        with mock.patch("native_runtime.reporting.process_table", return_value={123: dict(bridge, start="reused pid")}):
            item = report_jobs(state)["jobs"][0]
        self.assertFalse(item["processObservation"]["leaseOwnerAlive"])
        self.assertFalse(item["processObservation"]["ownerAlive"])
        self.assertEqual(item["state"], "idle")

    def test_factory_report_rejects_sensitive_or_invalid_phase_counters(self):
        base = {"kind": "factory-session", "sessionId": OTHER}
        for usage in ({"api_key": "SECRET"}, {"input_tokens": True}, {"input_tokens": -1},
                      {"input_tokens": "SECRET"}, {"input_tokens": 10**16}):
            result = extract_usage(dict(base, reportedPhaseUsage=usage))
            self.assertIsNone(result["bridgeReportedPhaseUsage"])
            self.assertFalse(result["bridgeReportAvailable"])
            self.assertNotIn("SECRET", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
