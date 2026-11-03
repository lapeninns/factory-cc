"""Shared admission for Factory-owned workspaces; never launches or kills an SDK.

The bridge owns execution and cleanup. This helper owns only a phase lease and
metadata in the native job registry. A lost admitted helper retains capacity
until that same bridge explicitly confirms cleanup with release or update.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
import sys
import time

from .core import (RuntimeConfig, RuntimeRefused, matches, now, process_identity,
                   read_job, state_lock, write_job)
from .supervisor import (CONTROLLER_SLOTS, OCCUPIED, TERMINAL, _all_jobs,
                         _host_workspace_conflict, _reconcile_locked,
                         execution_lane, profile_conflicts)
from .workspace import git

MAX_MESSAGE = 64 * 1024
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
RELEASE_STATES = frozenset(("waiting_host", "idle", "completed", "failed", "cancelled", "interrupted", "unknown"))
UPDATE_STATES = frozenset(("completed", "failed", "cancelled", "interrupted"))
TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
SUBSCRIPTION_PROFILES = frozenset("team" + str(number) for number in range(1, 9))


class ProtocolError(RuntimeRefused):
    pass


def _identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ProtocolError("invalid_identifier")
    return value


def validate_worktree(value, workspace_policy=None):
    """Workers require linked worktrees; explicit host controllers may use folders."""
    if workspace_policy not in (None, "controller-readonly", "controller-host"):
        raise ProtocolError("invalid_workspace_policy")
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise ProtocolError("absolute_worktree_required")
    path = Path(value)
    try:
        if path.resolve(strict=True) != path:
            raise ProtocolError("canonical_worktree_required")
        info = path.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ProtocolError("owned_worktree_required")
        if workspace_policy == "controller-host":
            # A folder is not a repository. Do not invent Git provenance or run
            # Git against an ancestor repository for a general host operation.
            return {"worktree": str(path), "workspaceKind": "directory",
                    "repository": None, "branch": None, "sourceCommit": None}
        marker = (path / ".git").lstat()
        marker_allowed = stat.S_ISREG(marker.st_mode) or (workspace_policy == "controller-readonly" and stat.S_ISDIR(marker.st_mode))
        if not marker_allowed or marker.st_uid != os.getuid():
            raise ProtocolError("linked_worktree_required")
        if git(path, "rev-parse", "--is-bare-repository") != "false":
            raise ProtocolError("non_bare_checkout_required")
        if Path(git(path, "rev-parse", "--show-toplevel")).resolve() != path:
            raise ProtocolError("worktree_root_required")
        git_dir = Path(git(path, "rev-parse", "--absolute-git-dir")).resolve(strict=True)
        common = Path(git(path, "rev-parse", "--git-common-dir"))
        common = (path / common).resolve(strict=True) if not common.is_absolute() else common.resolve(strict=True)
        if (git_dir == common and workspace_policy != "controller-readonly") or git_dir.stat().st_uid != os.getuid():
            raise ProtocolError("linked_worktree_required")
        commit = git(path, "rev-parse", "HEAD")
        branch = git(path, "symbolic-ref", "--short", "HEAD")
    except (OSError, ValueError, RuntimeRefused) as error:
        raise ProtocolError("worktree_unavailable") from error
    return {"worktree": str(path), "repository": str(common.parent if common.name == ".git" else common),
            "branch": branch, "sourceCommit": commit}


def _base_request(request, operation):
    if not isinstance(request, dict) or request.get("op") != operation:
        raise ProtocolError("invalid_operation")
    allowed = {"op", "factorySessionId", "bridgeSessionId", "cwd", "role", "subscriptionProfile", "workspacePolicy"}
    if operation == "update":
        allowed |= {"state", "usage", "sdkSessionId", "cleanupVerified"}
    if set(request) - allowed:
        raise ProtocolError("unexpected_fields")
    factory = _identifier(request.get("factorySessionId"))
    bridge = _identifier(request.get("bridgeSessionId"))
    role = _identifier(request.get("role", "session"))
    subscription_profile = request.get("subscriptionProfile")
    if "subscriptionProfile" in request and (not isinstance(subscription_profile, str)
                                               or subscription_profile not in SUBSCRIPTION_PROFILES):
        raise ProtocolError("invalid_subscription_profile")
    policy = request.get("workspacePolicy")
    if "workspacePolicy" in request and (policy not in ("controller-readonly", "controller-host") or subscription_profile is None
                                           or role in ("worker", "validator")
                                           or (policy == "controller-host" and role not in ("chat", "orchestrator"))):
        raise ProtocolError("invalid_controller_policy")
    workspace = validate_worktree(request.get("cwd"), policy)
    if policy is not None:
        workspace["workspacePolicy"] = policy
    job_id = "factory-" + hashlib.sha256((factory + "\0" + bridge).encode()).hexdigest()[:32]
    return factory, bridge, role, workspace, job_id, subscription_profile


def _usage(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - set(TOKEN_FIELDS):
        raise ProtocolError("invalid_usage")
    if any(not isinstance(n, int) or isinstance(n, bool) or not 0 <= n <= 10**15 for n in value.values()):
        raise ProtocolError("invalid_usage")
    return dict(value)


def _owner():
    identity = process_identity(os.getppid())
    supervisor = process_identity(os.getpid())
    if not identity or not supervisor:
        raise ProtocolError("owner_identity_unavailable")
    return identity, supervisor


def _verify_binding(job, factory, bridge, workspace, owner, subscription_profile):
    if (job.get("kind") != "factory-session" or job.get("factorySessionId") != factory
            or job.get("bridgeSessionId") != bridge or job.get("worktree") != workspace["worktree"]
            or job.get("workspacePolicy") != workspace.get("workspacePolicy")
            or job.get("profile") != (subscription_profile or "factory-api")
            or job.get("subscriptionProfile") != subscription_profile
            or (subscription_profile is not None and job.get("authMode") != "subscription")
            or (subscription_profile is None and job.get("authMode") not in (None, "api"))
            or job.get("leaseOwnerIdentity") != owner or not matches(owner)):
        raise ProtocolError("lease_binding_mismatch")


def create_or_resume(config, request):
    factory, bridge, role, workspace, job_id, subscription_profile = _base_request(request, "acquire")
    owner, supervisor = _owner()
    with state_lock(config):
        jobs = _reconcile_locked(config)
        existing = next((job for job in jobs if job.get("id") == job_id), None)
        if existing:
            _verify_binding(existing, factory, bridge, workspace, owner, subscription_profile)
            if existing.get("state") in TERMINAL:
                raise ProtocolError("terminal_session_cannot_reacquire")
            if existing.get("externalCleanupRequired") or existing.get("state") in OCCUPIED or existing.get("state") == "waiting_slot":
                raise ProtocolError("lease_already_active_or_uncertain")
            job = existing
            phase = {key: job.get(key) for key in ("attempt", "state", "startedAt", "endedAt")}
            job["attemptHistory"] = (job.get("attemptHistory", []) + [phase])[-32:]
            job["attempt"] = job.get("attempt", 0) + 1
            for key in ("cancelRequestedAt", "endedAt", "admittedAt", "startedAt", "reason"):
                job.pop(key, None)
        else:
            if any(_workspace_conflict(job, workspace) and job.get("state") not in TERMINAL
                   and "controller-host" not in (job.get("workspacePolicy"), workspace.get("workspacePolicy"))
                   for job in jobs):
                raise ProtocolError("workspace_already_bound")
            job = {"version": 1, "id": job_id, "kind": "factory-session", "profile": subscription_profile or "factory-api",
                   "factorySessionId": factory, "bridgeSessionId": bridge, "role": role,
                   "createdAt": now(), "attempt": 1, **workspace,
                   "requested": {"model": "claude-opus-5-5", "effort": "medium", "ultracode": True},
                   "ownedProcesses": [], "cleanupVerified": None,
                   "processOwnership": "Bridge owns SDK execution; lease helper has no process-control authority."}
            if subscription_profile is not None:
                job.update(subscriptionProfile=subscription_profile, authMode="subscription")
        job.update(state="waiting_slot", queuedAt=now(), supervisorIdentity=supervisor,
                   leaseOwnerIdentity=owner, externalCleanupRequired=False)
        write_job(config, job)
    return job


def _workspace_conflict(left, right):
    if "controller-host" in (left.get("workspacePolicy"), right.get("workspacePolicy")):
        return _host_workspace_conflict(left, right)
    if left.get("worktree") != right.get("worktree"):
        return False
    return not (left.get("workspacePolicy") == "controller-readonly"
                and right.get("workspacePolicy") == "controller-readonly")


def reserve(config, job):
    with state_lock(config):
        jobs = _reconcile_locked(config)
        current = read_job(config, job["id"])
        if current.get("cancelRequestedAt"):
            return "cancelled"
        if not matches(job["leaseOwnerIdentity"]):
            return "owner_lost"
        occupied = [item for item in jobs if item.get("state") in OCCUPIED]
        lane = execution_lane(job)
        lane_limit = CONTROLLER_SLOTS if lane == "controller" else config.max_running
        if sum(execution_lane(item) == lane for item in occupied) >= lane_limit:
            return "wait"
        eligible = [item for item in jobs if item.get("state") == "waiting_slot"
                    and execution_lane(item) == lane
                    and not any(_workspace_conflict(item, running) for running in occupied)
                    and not profile_conflicts(item, occupied)]
        eligible.sort(key=lambda item: (item.get("queuedAt", ""), item["id"]))
        if not eligible or eligible[0]["id"] != job["id"]:
            return "wait"
        # Persist the conservative lease before telling the bridge it may start.
        job.update(state="running", admittedAt=now(), startedAt=now(), externalCleanupRequired=True)
        write_job(config, job)
        return "ready"


def _completion_fields(sdk_session_id, cleanup_verified):
    fields = {}
    if sdk_session_id is not None:
        fields["sessionId"] = _identifier(sdk_session_id)
    if cleanup_verified is not None:
        if not isinstance(cleanup_verified, bool):
            raise ProtocolError("invalid_cleanup_report")
        fields["reportedCleanupVerified"] = cleanup_verified
        fields["cleanupEvidenceSource"] = "bridge"
    return fields


def finish(config, job, state, usage=None, reason="bridge_confirmed_phase_end", sdk_session_id=None, cleanup_verified=None):
    if not isinstance(state, str) or state not in RELEASE_STATES:
        raise ProtocolError("invalid_release_state")
    counters = _usage(usage)
    fields = _completion_fields(sdk_session_id, cleanup_verified)
    with state_lock(config):
        current = read_job(config, job["id"])
        if current.get("supervisorIdentity") != job["supervisorIdentity"]:
            raise ProtocolError("lease_generation_changed")
        current.update(state=state, endedAt=now(), externalCleanupRequired=state == "unknown",
                       reason=reason, cleanupVerified=None, **fields)
        if counters is not None:
            # Per-phase provider report, not independently verified billing.
            current["reportedPhaseUsage"] = counters
        write_job(config, current)
        return current


def uncertain(config, job, reason):
    with state_lock(config):
        current = read_job(config, job["id"])
        if current.get("supervisorIdentity") == job["supervisorIdentity"]:
            current.update(state="unknown", externalCleanupRequired=True, reason=reason, cleanupVerified=None)
            write_job(config, current)


def update(config, request):
    factory, bridge, _role, workspace, job_id, subscription_profile = _base_request(request, "update")
    state = request.get("state")
    if not isinstance(state, str) or state not in UPDATE_STATES:
        raise ProtocolError("invalid_update_state")
    counters = _usage(request.get("usage"))
    fields = _completion_fields(request.get("sdkSessionId"), request.get("cleanupVerified"))
    owner, _ = _owner()
    with state_lock(config):
        job = read_job(config, job_id)
        _verify_binding(job, factory, bridge, workspace, owner, subscription_profile)
        if matches(job.get("supervisorIdentity")):
            raise ProtocolError("active_helper_owns_lease")
        if job.get("state") == "waiting_slot":
            raise ProtocolError("queued_helper_owns_lease")
        if job.get("externalCleanupRequired") and request.get("cleanupVerified") is not True:
            raise ProtocolError("cleanup_confirmation_required")
        job.update(state=state, endedAt=now(), externalCleanupRequired=False,
                   reason="bridge_confirmed_session_end", cleanupVerified=None, **fields)
        if counters is not None:
            job["reportedPhaseUsage"] = counters
        write_job(config, job)
        return job


class Lines:
    def __init__(self, fd):
        self.fd, self.buffer, self.eof = fd, b"", False

    def poll(self, timeout):
        if b"\n" not in self.buffer and not self.eof:
            ready, _, _ = select.select([self.fd], [], [], timeout)
            if not ready:
                return None
            chunk = os.read(self.fd, MAX_MESSAGE + 1)
            if chunk:
                self.buffer += chunk
            else:
                self.eof = True
        if len(self.buffer) > MAX_MESSAGE:
            raise ProtocolError("message_too_large")
        if b"\n" in self.buffer:
            raw, self.buffer = self.buffer.split(b"\n", 1)
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError) as error:
                raise ProtocolError("invalid_json") from error
            if not isinstance(value, dict):
                raise ProtocolError("object_required")
            return value
        if self.eof:
            if self.buffer:
                raise ProtocolError("unterminated_message")
            raise EOFError()
        return None


def emit(event, job=None, **fields):
    value = {"ok": True, "event": event, **fields}
    if job:
        value["jobId"] = job["id"]
    print(json.dumps(value, separators=(",", ":")), flush=True)


def serve(config, input_fd=0):
    lines = Lines(input_fd)
    job = None
    admitted = False
    try:
        deadline = time.monotonic() + 30
        request = None
        while request is None:
            if time.monotonic() >= deadline:
                raise ProtocolError("initial_message_timeout")
            request = lines.poll(config.poll_interval)
        if request.get("op") == "update":
            job = update(config, request)
            emit("updated", job, state=job["state"])
            return 0
        job = create_or_resume(config, request)
        emit("queued", job)
        while not admitted:
            message = lines.poll(0)
            if message is not None:
                if message != {"op": "cancel"}:
                    raise ProtocolError("only_cancel_allowed_while_queued")
                finish(config, job, "cancelled", reason="cancelled_before_admission")
                emit("cancelled", job)
                return 0
            result = reserve(config, job)
            if result in ("cancelled", "owner_lost"):
                finish(config, job, "cancelled", reason="cancelled_before_admission")
                emit("cancelled", job)
                return 0
            if result == "ready":
                admitted = True
                emit("ready", job)
                break
            time.sleep(config.poll_interval)
        while True:
            message = lines.poll(config.poll_interval)
            if message is None:
                if not matches(job["leaseOwnerIdentity"]):
                    raise ProtocolError("bridge_owner_lost")
                continue
            if message.get("op") != "release" or set(message) - {"op", "state", "usage", "sdkSessionId", "cleanupVerified"}:
                raise ProtocolError("release_required_after_admission")
            job = finish(config, job, message.get("state"), message.get("usage"),
                         sdk_session_id=message.get("sdkSessionId"), cleanup_verified=message.get("cleanupVerified"))
            emit("released", job, state=job["state"])
            return 0
    except (EOFError, ProtocolError, RuntimeRefused, BrokenPipeError) as error:
        if job and request.get("op") != "update":
            if admitted:
                uncertain(config, job, "bridge_release_unconfirmed")
            else:
                finish(config, job, "cancelled", reason="lease_connection_ended_before_admission")
        # Fixed diagnostics only; inputs and underlying command errors stay private.
        try:
            response = {"ok": False, "error": "factory_lease_refused"}
            # Only fixed category values cross the boundary. Never include raw
            # paths, commands or exception messages in the wire response.
            if isinstance(error, ProtocolError):
                if str(error) in {"absolute_worktree_required", "canonical_worktree_required", "owned_worktree_required",
                                  "linked_worktree_required", "non_bare_checkout_required", "worktree_root_required", "worktree_unavailable"}:
                    response["code"] = "invalid_workspace"
                elif str(error) in {"invalid_identifier", "invalid_subscription_profile", "invalid_workspace_policy", "invalid_controller_policy"}:
                    response["code"] = "invalid_binding"
            print(json.dumps(response), flush=True)
        except BrokenPipeError:
            pass
        return 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-root", required=True, type=Path)
    parser.add_argument("--max-running", type=int, default=2)
    args = parser.parse_args(argv)
    if not args.state_root.is_absolute():
        parser.error("state root must be absolute")
    try:
        config = RuntimeConfig(args.state_root, args.state_root, max_running=args.max_running)
        return serve(config)
    except (OSError, RuntimeRefused):
        print(json.dumps({"ok": False, "error": "factory_lease_unavailable"}), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
