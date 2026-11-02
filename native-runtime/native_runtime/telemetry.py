"""Bounded, read-only extraction of native Claude session metadata.

Only the job's exact session and descendants are read. Conversation content,
tool arguments, error messages and account identifiers never enter the result.
Counters are observations, not remaining subscription quota or billing evidence.
"""
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 1024 * 1024
MAX_FILES = 256
MAX_DEPTH = 6
MAX_DIRECTORIES = 1024
TOKEN_FIELDS = {
    "input": "input_tokens",
    "output": "output_tokens",
    "cacheRead": "cache_read_input_tokens",
    "cacheCreation": "cache_creation_input_tokens",
}
WORKFLOW_STATES = frozenset(("running", "pending", "paused", "completed", "failed", "cancelled", "canceled", "interrupted"))
EFFORTS = frozenset(("low", "medium", "high", "xhigh", "max"))
IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:/-]{1,160}$")


def _identifier(value):
    return value if isinstance(value, str) and IDENTIFIER.fullmatch(value) else None


def _number(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10**15 else None


def _safe_path(path, root=None):
    """Reject symlinks, including an ancestor changed to a symlink."""
    path = Path(path)
    if not path.is_absolute():
        return False
    if root is not None:
        try:
            path.relative_to(root)
        except ValueError:
            return False
    current = Path(path.anchor)
    try:
        for part in path.parts[1:]:
            current /= part
            if current.is_symlink():
                return False
    except OSError:
        return False
    return True


class _Reader:
    def __init__(self):
        self.bytes = 0
        self.files = 0
        self.skipped = 0
        self.malformed = 0
        self.incomplete = 0
        self.latest_mtime = None
        self.limited = False

    def read(self, path, root, lines=True):
        if self.files >= MAX_FILES or self.bytes >= MAX_TOTAL_BYTES:
            self.limited = True
            return []
        if not _safe_path(path, root):
            self.skipped += 1
            return []
        fd = None
        try:
            fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                self.skipped += 1
                return []
            self.files += 1
            self.latest_mtime = max(info.st_mtime, self.latest_mtime or 0)
            remaining = min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - self.bytes)
            amount = min(info.st_size, remaining)
            self.limited |= amount < info.st_size
            with os.fdopen(fd, "rb") as handle:
                fd = None
                raw = handle.read(amount)
            self.bytes += len(raw)
        except OSError:
            self.skipped += 1
            return []
        finally:
            if fd is not None:
                os.close(fd)
        chunks = raw.splitlines(keepends=True) if lines else [raw]
        if lines and chunks and not chunks[-1].endswith((b"\n", b"\r")):
            # A still-growing last record may be valid JSON but is not committed
            # by its newline. Read it on a later observation instead.
            chunks.pop()
            self.incomplete += 1
        result = []
        for chunk in chunks:
            if len(chunk) > (MAX_LINE_BYTES if lines else MAX_FILE_BYTES):
                self.limited = True
                continue
            try:
                obj = json.loads(chunk)
                if isinstance(obj, dict):
                    result.append(obj)
                else:
                    self.malformed += 1
            except (ValueError, UnicodeError):
                self.malformed += 1
        return result


def _session_locations(job):
    metadata = job.get("metadata") if isinstance(job.get("metadata"), dict) else {}
    config = job.get("configDir", job.get("config_dir", metadata.get("configDir")))
    workspace = job.get("worktree", job.get("workspace"))
    session = job.get("sessionId", job.get("session_id"))
    if not isinstance(config, str) or not isinstance(workspace, str):
        return []
    try:
        # Canonical UUID form also rules out path traversal.
        if str(uuid.UUID(session)) != session:
            return []
    except (ValueError, TypeError, AttributeError):
        return []
    config_path = Path(config)
    workspace_path = Path(workspace)
    if not config_path.is_absolute() or not workspace_path.is_absolute() or not _safe_path(config_path):
        return []
    # Current native releases use non-alphanumeric -> '-'. The slash-only
    # encoding supports older stores, still without an unbounded home scan.
    keys = [re.sub(r"[^A-Za-z0-9]", "-", workspace), workspace.replace("/", "-")]
    return [(config_path / "projects" / key, session) for key in dict.fromkeys(keys)]


def _descendants(root, base, reader):
    """Walk only the exact session tree, never following symbolic links."""
    if not base.is_dir() or not _safe_path(base, root):
        return []
    paths = []
    try:
        for index, (directory, dirs, names) in enumerate(os.walk(str(base), followlinks=False)):
            if index >= MAX_DIRECTORIES:
                reader.limited = True
                break
            directory_path = Path(directory)
            depth = len(directory_path.relative_to(base).parts)
            dirs[:] = sorted(d for d in dirs if not (directory_path / d).is_symlink())
            if depth >= MAX_DEPTH:
                reader.limited |= bool(dirs)
                dirs[:] = []
            for name in sorted(names):
                path = directory_path / name
                if path.suffix not in (".jsonl", ".json") or path.is_symlink():
                    continue
                paths.append(path)
                if len(paths) >= MAX_FILES:
                    reader.limited = True
                    return paths
    except OSError:
        reader.skipped += 1
    return paths


def _api_error(record):
    """Recognize explicit error fields only; never classify prompt contents."""
    is_error = record.get("isApiErrorMessage") is True
    if record.get("type") == "system" and record.get("subtype") == "api_error":
        is_error = True
    error = record.get("error")
    if record.get("type") == "error" and isinstance(error, dict):
        is_error = True
    if not is_error:
        return None
    category = "api_error"
    if isinstance(error, dict):
        if error.get("type") == "rate_limit_error" or error.get("status") == 429 or error.get("status_code") == 429:
            category = "rate_limited"
    if record.get("errorType") == "rate_limit_error" or record.get("statusCode") == 429:
        category = "rate_limited"
    return category


def _bridge_phase_usage(job):
    """Latest phase report has no message IDs or cross-phase dedup contract."""
    if job.get("kind") != "factory-session":
        return None
    value = job.get("reportedPhaseUsage")
    if not isinstance(value, dict) or not value or set(value) - set(TOKEN_FIELDS.values()):
        return None
    if any(_number(count) is None for count in value.values()):
        return None
    phase = _number(job.get("attempt"))
    return {"counters": dict(value), "phase": phase,
            "source": "bridge report",
            "scope": "latest stored phase; not a cumulative session total",
            "independentlyReconciled": False,
            "includedInTranscriptTokens": False}


def extract_usage(job):
    """Return a redacted snapshot for exactly one recorded job/session."""
    reader = _Reader()
    messages = {}
    models, efforts, versions = set(), set(), set()
    workflows = {}
    journals = {}
    errors = {}
    missing_ids = 0
    root_seen = False
    session_id = job.get("sessionId", job.get("session_id"))
    seen_paths = set()
    for project, session in _session_locations(job):
        root_file = project / (session + ".jsonl")
        base = project / session
        if root_file.is_file() and _safe_path(root_file, project):
            root_seen = True
        paths = ([root_file] if root_file.is_file() else []) + _descendants(project, base, reader)
        for path in paths:
            if str(path) in seen_paths:
                continue
            seen_paths.add(str(path))
            is_root = path == root_file
            is_journal = path.name == "journal.jsonl"
            is_workflow_state = path.suffix == ".json" and path.parent.name == "workflows"
            if not (path.suffix == ".jsonl" or is_workflow_state):
                continue
            records = reader.read(path, project, lines=path.suffix == ".jsonl")
            for record in records:
                # Explicit mismatched identity must never be attributed here.
                record_session = record.get("sessionId")
                if record_session is not None and record_session != session_id:
                    continue
                if is_workflow_state:
                    run_id = _identifier(record.get("runId"))
                    status = record.get("status")
                    if run_id and path.stem == run_id:
                        item = {"id": run_id, "state": status if status in WORKFLOW_STATES else "unknown"}
                        for field in ("agentCount", "durationMs", "totalTokens", "totalToolCalls"):
                            value = _number(record.get(field))
                            if value is not None:
                                item[field] = value
                        item["defaultModel"] = _identifier(record.get("defaultModel"))
                        workflows[run_id] = item
                    continue
                if is_journal:
                    # A child result is evidence about that child, not proof that
                    # the workflow completed. Keep the enclosing state unknown
                    # until the native workflow state file records it.
                    run_id = _identifier(path.parent.name)
                    agent_id = _identifier(record.get("agentId"))
                    if run_id and agent_id:
                        journal = journals.setdefault(run_id, {"started": set(), "results": set(), "errors": set()})
                        if record.get("type") == "started":
                            journal["started"].add(agent_id)
                        elif record.get("type") == "result":
                            journal["results"].add(agent_id)
                        elif record.get("type") in ("error", "failed"):
                            journal["errors"].add(agent_id)
                    continue  # Result text and user-authored labels never leave the file.
                error = _api_error(record)
                if error:
                    key = _identifier(record.get("uuid")) or (str(path), len(errors))
                    errors[key] = error
                if record.get("type") != "assistant" or not isinstance(record.get("message"), dict):
                    continue
                message = record["message"]
                usage = message.get("usage")
                if not isinstance(usage, dict) or record.get("isApiErrorMessage") is True:
                    continue
                message_id = _identifier(message.get("id"))
                if message_id is None:
                    missing_ids += 1
                    continue
                token_values = {key: _number(usage.get(field)) for key, field in TOKEN_FIELDS.items()}
                if not any(value is not None for value in token_values.values()):
                    continue
                # Native transcripts repeat the same message for multiple content
                # blocks. Maximum snapshots avoid summing duplicates or an earlier
                # partial streaming counter over the final counter.
                prior = messages.setdefault(message_id, {key: 0 for key in TOKEN_FIELDS})
                for key, value in token_values.items():
                    if value is not None:
                        prior[key] = max(prior[key], value)
                model = _identifier(message.get("model"))
                if model:
                    models.add(model)
                effort = record.get("effort", record.get("perTurnEffort"))
                if effort in EFFORTS:
                    efforts.add(effort)
                version = _identifier(record.get("version"))
                if version:
                    versions.add(version)
    for run_id, journal in journals.items():
        item = workflows.setdefault(run_id, {"id": run_id, "state": "unknown", "defaultModel": None})
        item["journal"] = {"agentsStarted": len(journal["started"]), "agentResults": len(journal["results"]),
                           "agentErrors": len(journal["errors"])}
    totals = {key: sum(item[key] for item in messages.values()) for key in TOKEN_FIELDS}
    tokens = dict(totals, total=sum(totals.values())) if messages else None
    age = max(0.0, time.time() - reader.latest_mtime) if reader.latest_mtime is not None else None
    result = {
        "available": bool(reader.files),
        "scope": "exact recorded native session and its descendants",
        "rootTranscriptObserved": root_seen,
        "status": "partial" if reader.limited or reader.skipped or reader.malformed or reader.incomplete else ("observed" if reader.files else "unavailable"),
        "tokens": tokens,
        "deduplicatedMessages": len(messages),
        "observedModels": sorted(models),
        "observedEfforts": sorted(efforts),
        "observedCliVersions": sorted(versions),
        "observedUltracode": None,
        "workflows": sorted(workflows.values(), key=lambda item: item["id"]),
        "workflowTokenSummariesAddedToTokens": False,
        "apiErrors": sum(value == "api_error" for value in errors.values()),
        "rateLimitErrors": sum(value == "rate_limited" for value in errors.values()),
        "sourceAgeSeconds": round(age, 3) if age is not None else None,
        "coverage": {"filesRead": reader.files, "bytesRead": reader.bytes, "skippedFiles": reader.skipped,
                     "malformedRecords": reader.malformed, "incompleteRecords": reader.incomplete,
                     "messagesWithoutId": missing_ids, "boundedReadLimitReached": reader.limited},
        "remainingSubscriptionAllowance": None,
        "billedCostUsd": None,
        "limitations": ["Transcript counters are reported usage, not billing or remaining subscription allowance.",
                        "A missing transcript, workflow or error does not establish success or absence of usage.",
                        "Workflow token summaries are separate observations and are never added to message counters.",
                        "Snapshots may omit in-flight records; capture time and source age describe freshness."],
    }
    if job.get("kind") == "factory-session":
        result["bridgeReportedPhaseUsage"] = _bridge_phase_usage(job)
        result["localEvidenceAvailable"] = result["available"]
        result["bridgeReportAvailable"] = result["bridgeReportedPhaseUsage"] is not None
        if not result["available"] and result["bridgeReportAvailable"]:
            result["available"] = True
            result["status"] = "bridge_report_only"
        result["scope"] = "exact recorded SDK session where local transcripts are configured, plus a separate bridge phase report"
        result["limitations"].append("Bridge phase counters can replace earlier phase reports and have no per-message dedup evidence; they are not added to transcript totals.")
    return result
