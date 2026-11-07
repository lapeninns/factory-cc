"""A foreground, ownership-aware supervisor for isolated native Claude jobs.

No model prompts, command lines, output or environment values are persisted.
The command builder is provided by the authenticated launcher.
"""
import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import sys
import termios
import time
import tty
import uuid

from .core import (RuntimeRefused, atomic_json, descendants, group_members, initialize, job_path, matches,
                   now, process_identity, process_table, read_job, read_json,
                   safe_id, state_lock, write_job)
from .workspace import create_workspace, git, validate_workspace


TERMINAL = frozenset(("completed", "failed", "cancelled", "interrupted"))
OCCUPIED = frozenset(("starting", "running", "orphaned", "cleanup_blocked", "unknown"))
CONTROLLER_SLOTS = 1
SUBSCRIPTION_PROFILES = frozenset("team" + str(number) for number in range(1, 9))


def execution_lane(job):
    """Only a fully bound subscription controller gets reserved capacity."""
    profile = job.get("profile")
    if (job.get("kind") == "factory-session"
            and job.get("authMode") == "subscription"
            and job.get("workspacePolicy") in ("controller-readonly", "controller-host", "factory-native")
            and job.get("role") in ("chat", "orchestrator")
            and isinstance(profile, str) and profile in SUBSCRIPTION_PROFILES
            and job.get("subscriptionProfile") == profile):
        return "controller"
    return "worker"


def holds_workspace(job):
    """A published host action keeps its write reservation while compute is free."""
    return (job.get("workspacePolicy") != "factory-native"
            and (job.get("state") in OCCUPIED or job.get("hostActionReservation") is True))


def occupies_compute(job):
    return job.get("state") in OCCUPIED and not (
        job.get("kind") == "factory-session"
        and job.get("workspacePolicy") == "controller-host"
        and job.get("hostActionReservation") is True
        and job.get("reportedCleanupVerified") is True)


def profile_conflicts(job, occupied):
    """Known controller and worker execution may share an account across lanes.

    Uncertain native execution retains the account until cleanup is confirmed.
    A host-only reservation with verified native cleanup is excluded before
    this check and continues to reserve only its workspace.
    """
    if job.get("kind") == "factory-session" and job.get("profile") == "factory-api":
        return False
    lane = execution_lane(job)
    for running in occupied:
        if running.get("profile") != job.get("profile"):
            continue
        if execution_lane(running) == lane:
            return True
        if running.get("state") in ("unknown", "orphaned", "cleanup_blocked"):
            return True
        owner = (running.get("leaseOwnerIdentity") if running.get("kind") == "factory-session"
                 else running.get("supervisorIdentity"))
        if not matches(owner):
            return True
    return False


def _host_workspace_conflict(left, right):
    if left.get("workspacePolicy") == right.get("workspacePolicy") == "factory-native":
        return False
    """Host operations reserve their folder tree, including native descendants."""
    if "controller-host" not in (left.get("workspacePolicy"), right.get("workspacePolicy")):
        return False
    try:
        first, second = Path(left["worktree"]), Path(right["worktree"])
        return first == second or first in second.parents or second in first.parents
    except (KeyError, TypeError):
        return True


def _all_jobs(config):
    return [read_json(path) for path in sorted((config.state_root / "jobs").glob("*.json"))]


def _live_known(job, table):
    identities = list(job.get("ownedProcesses", []))
    if job.get("childIdentity"):
        identities.append(job["childIdentity"])
    return [item for item in identities if matches(item, table)]


def _reconcile_locked(config):
    table = process_table()
    jobs = _all_jobs(config)
    for job in jobs:
        if job.get("state") in TERMINAL or matches(job.get("supervisorIdentity"), table):
            continue
        if job.get("hostActionReservation") is True and not matches(job.get("leaseOwnerIdentity"), table):
            job.update(state="unknown", externalCleanupRequired=True, reason="host_action_owner_lost")
            write_job(config, job)
            continue
        if job.get("hostActionReservation") is True and job.get("state") == "waiting_slot":
            previous = job.pop("admissionPreviousPhase", {})
            job.update(state=previous.get("state", "waiting_host"),
                       externalCleanupRequired=False, reason="queued_helper_lost_host_reservation_retained")
            write_job(config, job)
            continue
        if job.get("kind") == "factory-session" and job.get("externalCleanupRequired"):
            # The lease helper does not own or contain the bridge's SDK. Its
            # disappearance cannot prove those external processes were cleaned.
            job.update(state="unknown", reason="external_runtime_cleanup_unproven")
            write_job(config, job)
            continue
        state = job.get("state")
        if state == "preparing":
            job.update(state="interrupted", endedAt=now(), reason="supervisor_lost_before_queue")
        elif state == "waiting_slot":
            job.update(state="interrupted", endedAt=now(), reason="queued_supervisor_lost")
        elif state in OCCUPIED:
            if state == "starting" and not job.get("processGroup") and job.get("spawnProtocol") != "durable-exec-gate-v1":
                job.update(state="unknown", reason="legacy_start_without_process_identity")
                write_job(config, job)
                continue
            known = _live_known(job, table)
            remaining = group_members(job.get("processGroup"), table) if job.get("processGroup") else []
            if known:
                job.update(state="orphaned", reason="supervisor_lost_owned_children_remain")
            elif remaining:
                job.update(state="unknown", reason="unattributed_group_requires_review")
            else:
                job.update(state="interrupted", endedAt=now(), reason="supervisor_lost_no_owned_processes")
        else:
            continue
        write_job(config, job)
    return jobs


def list_jobs(config, reconcile=True):
    with state_lock(config):
        return _reconcile_locked(config) if reconcile else _all_jobs(config)


def get_job(config, job_id):
    with state_lock(config):
        return read_job(config, job_id)


def request_cancel(config, job_id):
    """Request cancellation; the owning live supervisor performs process signals."""
    with state_lock(config):
        _reconcile_locked(config)
        job = read_job(config, job_id)
        if job["state"] in TERMINAL:
            return job
        job["cancelRequestedAt"] = now()
        write_job(config, job)
        return job


def _persist(config, job, **fields):
    with state_lock(config):
        current = read_job(config, job["id"])
        if current.get("cancelRequestedAt"):
            job["cancelRequestedAt"] = current["cancelRequestedAt"]
        job.update(fields)
        write_job(config, job)


def _reserve(config, job):
    with state_lock(config):
        jobs = _reconcile_locked(config)
        current = read_job(config, job["id"])
        if current.get("cancelRequestedAt"):
            job.update(current)
            return "cancelled"
        occupied = [item for item in jobs if occupies_compute(item)]
        reserved = [item for item in jobs if holds_workspace(item) and item.get("id") != job.get("id")]
        lane = execution_lane(job)
        lane_limit = CONTROLLER_SLOTS if lane == "controller" else config.max_running
        if sum(execution_lane(item) == lane for item in occupied) >= lane_limit:
            return "wait"
        if profile_conflicts(job, occupied):
            return "wait"
        if any(job.get("worktree") == item.get("worktree") or _host_workspace_conflict(job, item) for item in reserved):
            return "wait"
        eligible = sorted((item for item in jobs if item.get("state") == "waiting_slot"
                           and execution_lane(item) == lane
                           and not profile_conflicts(item, occupied)
                           and not any(item.get("worktree") == running.get("worktree") or _host_workspace_conflict(item, running) for running in reserved
                                       if running.get("id") != item.get("id"))),
                          key=lambda item: (item.get("queuedAt", ""), item["id"]))
        if not eligible or eligible[0]["id"] != job["id"]:
            return "wait"
        job.update(state="starting", admittedAt=now())
        write_job(config, job)
        return "start"


def _new_job(config, profile, repo, workflow, timeout_seconds, base_ref, requested, metadata):
    if profile not in SUBSCRIPTION_PROFILES:
        raise RuntimeRefused("Only team1 through team8 are configured.")
    job_id = "job-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime()) + "-" + uuid.uuid4().hex[:10]
    identity = process_identity(os.getpid())
    if not identity:
        raise RuntimeRefused("The supervisor identity could not be established.")
    job = {"version": 1, "id": job_id, "kind": "native-session", "profile": profile, "state": "preparing",
           "createdAt": now(), "supervisorIdentity": identity, "workflow": workflow,
           "sessionId": str(uuid.uuid4()), "resume": False, "attempt": 1,
           "spawnProtocol": "durable-exec-gate-v1",
           "timeoutSeconds": timeout_seconds, "requested": requested or {},
           "metadata": metadata or {}, "ownedProcesses": []}
    with state_lock(config):
        write_job(config, job)
        try:
            job.update(create_workspace(config, repo, job_id, base_ref))
            job.update(state="waiting_slot", queuedAt=now())
            write_job(config, job)
        except Exception:
            job.update(state="failed", endedAt=now(), reason="workspace_creation_failed")
            write_job(config, job)
            raise
    return job


def _resume_job(config, profile, repo, job_id, timeout_seconds):
    with state_lock(config):
        _reconcile_locked(config)
        job = read_job(config, safe_id(job_id))
        if job.get("kind", "native-session") != "native-session":
            raise RuntimeRefused("Only native session jobs can be resumed.")
        if job.get("profile") != profile:
            raise RuntimeRefused("A job can be resumed only with its recorded profile.")
        if job.get("state") not in TERMINAL:
            raise RuntimeRefused("This job is still active or requires process recovery.")
        if any(item.get("parentJobId") == job_id and item.get("state") not in TERMINAL for item in _all_jobs(config)):
            raise RuntimeRefused("This workspace has an active or queued check.")
        if repo is not None and Path(repo).resolve() != Path(job["repository"]).resolve():
            raise RuntimeRefused("Resume repository differs from the recorded job.")
        validate_workspace(config, job)
        previous = {key: job.get(key) for key in ("attempt", "state", "startedAt", "endedAt", "returnCode", "reason")}
        job.setdefault("attemptHistory", []).append(previous)
        for key in ("cancelRequestedAt", "endedAt", "returnCode", "reason", "childIdentity", "processGroup", "startedAt", "admittedAt"):
            job.pop(key, None)
        job.update(state="waiting_slot", queuedAt=now(), supervisorIdentity=process_identity(os.getpid()),
                   resume=True, attempt=job.get("attempt", 1) + 1, ownedProcesses=[], timeoutSeconds=timeout_seconds,
                   spawnProtocol="durable-exec-gate-v1")
        write_job(config, job)
        return job


def _signal_owned(job, sig):
    table = process_table()
    pgid = job.get("processGroup")
    owned = _live_known(job, table)
    sent = False
    if pgid and pgid != os.getpgrp() and any(item["pgid"] == pgid for item in owned):
        try:
            os.killpg(pgid, sig)
            sent = True
        except ProcessLookupError:
            pass
    for item in owned:
        if item["pgid"] == pgid:
            continue
        # Detached descendants receive a PID-targeted signal only after matching
        # their recorded start identity. Never signal their unrelated process group.
        if matches(item):
            try:
                os.kill(item["pid"], sig)
                sent = True
            except ProcessLookupError:
                pass
    return sent


def _observe_owned(job, table=None):
    table = process_table() if table is None else table
    roots = list(job.get("ownedProcesses", []))
    if job.get("childIdentity"):
        roots.append(job["childIdentity"])
    known = descendants(roots, table)
    if any(item["pgid"] == job.get("processGroup") for item in known):
        known.extend(group_members(job["processGroup"], table))
    job["ownedProcesses"] = list({item["pid"]: item for item in known}.values())
    return job["ownedProcesses"]


def _shutdown(config, job, proc):
    """Reap the child and keep the slot if cleanup cannot be proved."""
    try:
        _observe_owned(job)
        _signal_owned(job, signal.SIGTERM)
        # Before the gate opens there may not yet be a ps identity. Popen retains
        # its unreaped direct child, so signalling that child cannot hit a reused PID.
        if proc.poll() is None:
            proc.terminate()
        deadline = time.monotonic() + config.cancel_grace
        while time.monotonic() < deadline:
            proc.poll()
            if not _observe_owned(job) and not group_members(job.get("processGroup")):
                return _reap_direct(proc, config.cancel_grace)
            time.sleep(min(config.poll_interval, 0.1))
        _signal_owned(job, signal.SIGKILL)
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=config.cancel_grace)
        except subprocess.TimeoutExpired:
            pass
        deadline = time.monotonic() + config.cancel_grace
        while time.monotonic() < deadline:
            if not _observe_owned(job) and not group_members(job.get("processGroup")):
                return _reap_direct(proc, config.cancel_grace)
            time.sleep(min(config.poll_interval, 0.1))
        return False
    except RuntimeRefused:
        # Observability loss is not proof of cleanup. Retain the admission slot.
        if proc.poll() is None:
            proc.terminate()
        return False


def _reap_direct(proc, timeout):
    try:
        proc.wait(timeout=timeout)
        return True
    except subprocess.TimeoutExpired:
        return False


def _terminal_size(slave):
    try:
        size = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
    except (OSError, ValueError):
        pass


def _pump_terminal(master, stdin_fd, interval):
    descriptors = [master]
    if stdin_fd is not None:
        descriptors.append(stdin_fd)
    readable, _, _ = select.select(descriptors, [], [], interval)
    if stdin_fd is not None and stdin_fd in readable:
        data = os.read(stdin_fd, 65536)
        if data:
            os.write(master, data)
    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError as exc:
            if exc.errno != errno.EIO:
                raise
            return
        if data:
            os.write(sys.stdout.fileno(), data)


def run_job(config, profile, repo, command_builder, workflow="implement", timeout_seconds=3600,
            job_id=None, base_ref="HEAD", requested=None, metadata=None, on_created=None):
    """Run (or resume) one isolated job, returning its durable terminal record.

    command_builder(job) returns (argv, environment); command content is never saved.
    Resumption retains the worktree and session ID and requires the same profile.
    on_created(job) can announce the queued job before admission and execution.
    """
    initialize(config)
    if not isinstance(timeout_seconds, (int, float)) or not 1 <= timeout_seconds <= 86400:
        raise RuntimeRefused("Job deadline must be between one second and 24 hours.")
    job = (_resume_job(config, profile, repo, job_id, timeout_seconds) if job_id else
           _new_job(config, profile, repo, workflow, timeout_seconds, base_ref, requested, metadata))
    if on_created is not None:
        try:
            on_created(dict(job))
        except BaseException:
            _finish(config, job, "failed", "job_announcement_failed", None, True)
            raise
    return _execute_job(config, job, command_builder, timeout_seconds)


def run_check(config, job_id, name, argv, env=None, timeout_seconds=600):
    """Execute a check in an idle job workspace and preserve the session outcome."""
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}", name):
        raise RuntimeRefused("Check name must be a short plain label.")
    if not isinstance(timeout_seconds, (int, float)) or not 1 <= timeout_seconds <= 86400:
        raise RuntimeRefused("Check deadline must be between one second and 24 hours.")
    with state_lock(config):
        _reconcile_locked(config)
        parent = read_job(config, job_id)
        if parent.get("kind", "native-session") != "native-session" or parent.get("state") not in TERMINAL:
            raise RuntimeRefused("Checks require an idle native job workspace.")
        path = validate_workspace(config, parent)
        if any(item.get("worktree") == str(path) and item.get("state") not in TERMINAL for item in _all_jobs(config)):
            raise RuntimeRefused("This job workspace is already active or queued.")
        check_id = "check-" + uuid.uuid4().hex
        check = {"version": 1, "id": check_id, "kind": "executed-check", "executed": False,
                 "jobId": parent["id"], "parentJobId": parent["id"], "workspaceOwnerId": parent["id"], "name": name,
                 "profile": parent["profile"], "state": "waiting_slot", "createdAt": now(),
                 "queuedAt": now(), "supervisorIdentity": process_identity(os.getpid()),
                 "repository": parent["repository"], "worktree": str(path), "branch": parent["branch"],
                 "head": git(path, "rev-parse", "HEAD"), "timeoutSeconds": timeout_seconds,
                 "ownedProcesses": [], "spawnProtocol": "durable-exec-gate-v1"}
        write_job(config, check)
    result = _execute_job(config, check, lambda _: (argv, dict(os.environ) if env is None else env), timeout_seconds)
    result["exitCode"] = result.get("returnCode")
    with state_lock(config):
        write_job(config, result)
        atomic_json(config.state_root / "checks" / parent["id"] / (check_id + ".json"), result)
    return result


def _execute_job(config, job, command_builder, timeout_seconds):
    interrupted = [False]
    original_handlers = {}
    proc = None
    master = slave = None
    gate_read = gate_write = None
    terminal_before = None
    stdin_fd = None
    terminal_state = "failed"
    reason = "launch_failed"
    clean = True
    try:
        def interrupt(signum, frame):
            interrupted[0] = True
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            original_handlers[signum] = signal.signal(signum, interrupt)
        while True:
            admission = _reserve(config, job)
            if admission == "cancelled" or interrupted[0]:
                terminal_state, reason = "cancelled", "cancelled_before_start"
                return _finish(config, job, terminal_state, reason, None, True)
            if admission == "start":
                break
            time.sleep(config.poll_interval)
        validate_workspace(config, job)
        argv, env = command_builder(dict(job))
        if not isinstance(argv, (list, tuple)) or not argv or not all(isinstance(item, str) for item in argv):
            raise RuntimeRefused("Command builder returned an invalid command.")
        interactive = sys.stdin.isatty() and sys.stdout.isatty()
        kwargs = {"cwd": job["worktree"], "env": env, "start_new_session": True}
        if interactive:
            master, slave = pty.openpty()
            _terminal_size(slave)
            stdin_fd = sys.stdin.fileno()
            terminal_before = termios.tcgetattr(stdin_fd)
            kwargs.update(stdin=slave, stdout=slave, stderr=slave,
                          preexec_fn=lambda: fcntl.ioctl(slave, termios.TIOCSCTTY, 0))
        gate_read, gate_write = os.pipe()
        gate_script = ("import os,sys;fd=int(sys.argv[1]);permit=os.read(fd,1);os.close(fd);"
                       "sys.exit(126) if permit!=b'1' else os.execvpe(sys.argv[2],sys.argv[2:],os.environ)")
        proc = subprocess.Popen([sys.executable, "-c", gate_script, str(gate_read), *argv],
                                pass_fds=(gate_read,), **kwargs)
        os.close(gate_read)
        gate_read = None
        job.update(processGroup=proc.pid)
        identity = process_identity(proc.pid)
        if not identity:
            raise RuntimeRefused("The gated child identity could not be established.")
        job.update(childIdentity=identity, ownedProcesses=group_members(proc.pid),
                   state="starting", childGate="waiting_for_durable_identity")
        _persist(config, job)
        os.write(gate_write, b"1")
        os.close(gate_write)
        gate_write = None
        job.update(state="running", startedAt=now(), childGate="released")
        if job.get("kind") == "executed-check":
            job["executed"] = True
        _persist(config, job)
        if interactive:
            tty.setraw(stdin_fd)
            def resize(signum, frame):
                _terminal_size(slave)
            original_handlers[signal.SIGWINCH] = signal.signal(signal.SIGWINCH, resize)
        began = time.monotonic()
        last_persist = 0.0
        while True:
            if master is not None:
                _pump_terminal(master, stdin_fd, config.poll_interval)
            else:
                time.sleep(config.poll_interval)
            table = process_table()
            _observe_owned(job, table)
            with state_lock(config):
                current = read_job(config, job["id"])
            if current.get("cancelRequestedAt") or interrupted[0]:
                terminal_state, reason = "cancelled", "cancellation_requested"
                break
            if time.monotonic() - began >= timeout_seconds:
                terminal_state, reason = "failed", "deadline_exceeded"
                break
            code = proc.poll()
            if code is not None:
                terminal_state = "completed" if code == 0 else "failed"
                reason = "process_exit"
                break
            if time.monotonic() - last_persist >= 1:
                _persist(config, job, observedAt=now())
                last_persist = time.monotonic()
        clean = _shutdown(config, job, proc)
        return _finish(config, job, terminal_state, reason, proc.returncode, clean)
    except BaseException:
        if proc is not None:
            clean = _shutdown(config, job, proc)
        _finish(config, job, "failed", "supervisor_error", proc.returncode if proc else None, clean)
        raise
    finally:
        if terminal_before is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, terminal_before)
        for descriptor in (master, slave, gate_read, gate_write):
            if descriptor is not None:
                os.close(descriptor)
        for signum, handler in original_handlers.items():
            signal.signal(signum, handler)


def _finish(config, job, state, reason, return_code, clean):
    if not clean:
        state, reason = "cleanup_blocked", "owned_process_cleanup_unproven"
    fields = {"state": state, "reason": reason, "returnCode": return_code,
              "cleanupVerified": clean, "observedAt": now()}
    if clean:
        fields["endedAt"] = now()
    _persist(config, job, **fields)
    return job
