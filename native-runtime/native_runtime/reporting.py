"""Read-only native/Factory job and executed-check report; no conversation export."""
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time

from .telemetry import extract_usage, _safe_path
from .core import RuntimeRefused, matches, process_table

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
STATES = frozenset(("preparing", "queued", "waiting_slot", "starting", "running", "idle", "waiting_host", "completed", "failed", "cancelled", "interrupted", "cleanup_blocked", "orphaned", "unknown"))


def _read_object(path, root):
    try:
        if not _safe_path(path, root) or not path.is_file() or path.stat().st_size > 1024 * 1024:
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _text(value, max_length=128):
    return value if isinstance(value, str) and len(value) <= max_length and not any(ord(c) < 32 for c in value) else None


def _time(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return None
            return parsed.timestamp()
        except (ValueError, OverflowError):
            pass
    return None


def _value(job, *names):
    for name in names:
        if name in job:
            return job[name]
    return None


def _checks(root, job):
    job_id = job.get("id")
    if not isinstance(job_id, str) or not NAME.fullmatch(job_id):
        return []
    folder = root / "checks" / job_id
    checks = []
    if not _safe_path(folder, root):
        return checks
    for path in sorted(folder.glob("*.json"))[:1000]:
        item = _read_object(path, root)
        if not item or item.get("kind") != "executed-check" or item.get("executed") is not True or item.get("jobId") != job_id:
            continue
        exit_code = item.get("exitCode", item.get("returnCode"))
        start, end = _time(item.get("startedAt")), _time(item.get("endedAt"))
        if not isinstance(exit_code, int) or isinstance(exit_code, bool) or start is None or end is None or end < start:
            continue
        worktree = _text(item.get("worktree"), 4096)
        if not worktree or worktree != job.get("worktree", job.get("workspace")):
            continue
        checks.append({"id": _text(path.stem), "name": _text(item.get("name")),
                       "exitCode": exit_code, "passed": exit_code == 0,
                       "startedAt": item["startedAt"], "endedAt": item["endedAt"],
                       "durationSeconds": round(end - start, 3),
                       "head": _text(item.get("head")),
                       "candidateFingerprint": _text(item.get("candidateFingerprint")),
                       "scope": "recorded command execution in this job's worktree"})
    return checks


def _process_observation(job, table):
    if job.get("kind") == "factory-session":
        helper = job.get("supervisorIdentity")
        lease_owner = job.get("leaseOwnerIdentity")
        helper_alive = matches(helper, table) if table is not None and isinstance(helper, dict) else None
        lease_owner_alive = matches(lease_owner, table) if table is not None and isinstance(lease_owner, dict) else None
        if table is None:
            state = "unknown"
        elif lease_owner_alive:
            state = "lease_owner_and_helper_alive" if helper_alive else "lease_owner_alive"
        elif helper_alive:
            state = "helper_alive_without_lease_owner"
        else:
            state = "not_observed"
        return {"ownerAlive": helper_alive, "leaseOwnerAlive": lease_owner_alive,
                "childAlive": None, "ownedProcessCount": None, "state": state,
                "authority": "lease observation only; SDK processes and cleanup belong to the bridge"}
    if table is None:
        return {"ownerAlive": None, "childAlive": None, "ownedProcessCount": None, "state": "unknown"}
    owner = job.get("supervisorIdentity")
    child = job.get("childIdentity")
    owner_alive = matches(owner, table) if isinstance(owner, dict) else None
    child_alive = matches(child, table) if isinstance(child, dict) else None
    known = job.get("ownedProcesses")
    known = list(known) if isinstance(known, list) else []
    if child:
        known.append(child)
    live_pids = {identity["pid"] for identity in known if isinstance(identity, dict) and matches(identity, table)}
    if owner_alive:
        state = "owner_and_children" if live_pids else "owner_alive"
    elif live_pids:
        state = "owned_children_without_owner"
    else:
        state = "not_observed"
    return {"ownerAlive": owner_alive, "childAlive": child_alive, "ownedProcessCount": len(live_pids), "state": state}


def _cleanup_observation(job):
    if job.get("kind") == "factory-session":
        reported = job.get("reportedCleanupVerified")
        required = job.get("externalCleanupRequired")
        return {"independentlyVerified": None,
                "bridgeReportedVerified": reported if isinstance(reported, bool) else None,
                "externalCleanupRequired": required if isinstance(required, bool) else None,
                "source": "bridge" if job.get("cleanupEvidenceSource") == "bridge" else None}
    value = job.get("cleanupVerified")
    return {"independentlyVerified": value if isinstance(value, bool) else None}


def report_jobs(state_root, observe_processes=True):
    """Return current evidence without changing job, process or telemetry state."""
    root = Path(state_root)
    if not root.is_absolute():
        root = root.absolute()
    now = time.time()
    result = {"schemaVersion": 1, "observedAt": datetime.now(timezone.utc).isoformat(),
              "jobs": [], "totals": {"jobs": 0, "recordedChecksPassed": 0, "recordedChecksFailed": 0,
                                      "reportedTokens": 0, "jobsWithTokenEvidence": 0},
              "warnings": [],
              "limitations": ["Saved job state is separate from process liveness and successful delivery.",
                              "Executed checks apply to their recorded candidate; they do not establish deployment or release.",
                              "Tokens do not establish remaining Team subscription allowance or billed cost."]}
    if not _safe_path(root) or not _safe_path(root / "jobs", root):
        result["warnings"].append("Unsafe or symlinked state directory; no jobs read.")
        return result
    table = None
    if observe_processes:
        try:
            table = process_table()
        except (RuntimeRefused, OSError, ValueError):
            result["warnings"].append("Process identities could not be observed; liveness is unknown.")
    result["processSnapshotAvailable"] = table is not None
    paths = sorted((root / "jobs").glob("*.json"))
    if len(paths) > 1000:
        result["warnings"].append("Job report limited to 1000 records.")
    for path in paths[:1000]:
        job = _read_object(path, root)
        if not job or job.get("id") != path.stem or not NAME.fullmatch(path.stem):
            result["warnings"].append("Unreadable or invalid job record omitted.")
            continue
        if job.get("kind") == "executed-check":
            continue  # Check processes are reported under their owning job.
        telemetry = extract_usage(job)
        checks = _checks(root, job)
        started = _time(_value(job, "startedAt", "started_at"))
        ended = _time(_value(job, "endedAt", "ended_at"))
        updated = _time(_value(job, "updatedAt", "updated_at", "heartbeatAt"))
        requested = job.get("requested") if isinstance(job.get("requested"), dict) else {}
        kind = job.get("kind", "native-session")
        item = {"id": path.stem, "profile": _text(job.get("profile")),
                "kind": kind if kind in ("native-session", "factory-session") else "unknown",
                "role": _text(job.get("role")),
                "state": job.get("state") if job.get("state") in STATES else "unknown",
                "recordedState": job.get("state") if job.get("state") in STATES else "unknown",
                "processObservation": _process_observation(job, table),
                "cleanupObservation": _cleanup_observation(job),
                "worktree": _text(job.get("worktree", job.get("workspace")), 4096),
                "branch": _text(job.get("branch")), "sourceCommit": _text(_value(job, "sourceCommit", "sourceHead", "source_head")),
                "workflow": _text(job.get("workflow")),
                "requested": {"model": _text(requested.get("model", job.get("model"))),
                              "effort": _text(requested.get("effort", job.get("effort"))),
                              "ultracode": requested.get("ultracode") if isinstance(requested.get("ultracode"), bool) else None},
                "sessionId": _text(_value(job, "sessionId", "session_id")),
                "startedAt": _value(job, "startedAt", "started_at"),
                "endedAt": _value(job, "endedAt", "ended_at"),
                "durationSeconds": round(max(0.0, (ended or now) - started), 3) if started is not None else None,
                "recordAgeSeconds": round(max(0.0, now - updated), 3) if updated is not None else None,
                "recordedExitCode": _value(job, "returnCode", "exitCode") if type(_value(job, "returnCode", "exitCode")) is int else None,
                "telemetry": telemetry, "checks": checks,
                "quality": {"recordedPasses": sum(check["passed"] for check in checks),
                            "recordedFailures": sum(not check["passed"] for check in checks),
                            "deliveryVerified": False}}
        result["jobs"].append(item)
        result["totals"]["jobs"] += 1
        result["totals"]["recordedChecksPassed"] += item["quality"]["recordedPasses"]
        result["totals"]["recordedChecksFailed"] += item["quality"]["recordedFailures"]
        if telemetry["tokens"] is not None:
            result["totals"]["reportedTokens"] += telemetry["tokens"]["total"]
            result["totals"]["jobsWithTokenEvidence"] += 1
    return result
