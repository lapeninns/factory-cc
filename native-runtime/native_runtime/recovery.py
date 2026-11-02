"""Private, immutable runtime releases and offline recovery checks.

This module never updates Claude, reads account stores, invokes a model, or
stops a process. Activating a release changes only the launcher pointer; jobs
already using an older release can finish with that release.
"""
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import uuid


MANIFEST_NAME = "release-manifest.json"
VALIDATED_CLI_VERSION = "2.1.316"
_RELEASE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}\Z")
_SKIP_PARTS = {"__pycache__", ".git", ".pytest_cache", "node_modules",
               "evidence", "outputs", "logs"}
_SCOPES = {
    "native_runtime": {".py"}, "tests": {".py"},
    "policies": {".md", ".json", ".txt"},
    "workflows": {".md", ".json", ".txt"}, "docs": {".md", ".txt"},
}
_ROOT_FILES = {"README.md", "package.json", "pyproject.toml", "team-job"}


class RecoveryError(ValueError):
    """A release cannot safely be prepared, selected, or verified."""


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _safe_relative(name):
    path = Path(name)
    return (isinstance(name, str) and name != "" and not path.is_absolute()
            and ".." not in path.parts and path.as_posix() == name
            and all(part not in _SKIP_PARTS for part in path.parts))


def _in_scope(relative):
    if not _safe_relative(relative):
        return False
    path = Path(relative)
    if len(path.parts) == 1:
        return path.name in _ROOT_FILES
    return path.parts[0] in _SCOPES and path.suffix in _SCOPES[path.parts[0]]


def _read_regular(path, private=False):
    # Nonblocking open avoids hanging on a malicious FIFO before fstat rejects it.
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(str(path), flags)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise RecoveryError("Expected a regular file: " + str(path))
            if private and (info.st_uid != os.getuid() or info.st_mode & 0o077):
                raise RecoveryError("Expected an owned private file: " + str(path))
            if info.st_size > 16 * 1024 * 1024:
                raise RecoveryError("Release input is too large: " + str(path))
            return stream.read(), info
    except OSError as error:
        raise RecoveryError("Cannot read regular release file: " + str(path)) from error


def _inventory(root, require_runtime=True):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise RecoveryError("Release source must be a real directory")
    files = {}
    for directory, folders, names in os.walk(str(root), followlinks=False):
        parent = Path(directory)
        relative_parent = parent.relative_to(root)
        selected_folders = []
        for folder in sorted(folders):
            relative = relative_parent / folder
            if folder in _SKIP_PARTS:
                continue
            if len(relative.parts) == 1 and folder not in _SCOPES:
                continue
            if (parent / folder).is_symlink():
                raise RecoveryError("Symlink directories are not release inputs: " + relative.as_posix())
            selected_folders.append(folder)
        folders[:] = selected_folders
        for name in sorted(names):
            relative = (relative_parent / name).as_posix()
            if not _in_scope(relative):
                continue
            data, info = _read_regular(root / relative)
            files[relative] = {"sha256": _digest(data), "bytes": len(data),
                               "executable": bool(info.st_mode & 0o111)}
    if require_runtime and (not files or not any(name.startswith("native_runtime/") for name in files)):
        raise RecoveryError("A release must contain native_runtime Python source")
    return files


def create_manifest(source_root, validated_cli_version=VALIDATED_CLI_VERSION):
    """Hash only the documented runtime/source scopes; ignore logs and secrets."""
    if not isinstance(validated_cli_version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", validated_cli_version):
        raise RecoveryError("The validated CLI version must be an exact semantic version")
    return {"schema": 1, "createdAt": _utc_now(),
            "validatedCliVersion": validated_cli_version,
            "files": _inventory(Path(source_root))}


def _atomic_write(path, data):
    path = Path(path)
    if path.is_symlink():
        raise RecoveryError("Refusing a symlink output: " + str(path))
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + "-", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_manifest(source_root, validated_cli_version=VALIDATED_CLI_VERSION):
    root = Path(source_root)
    manifest = create_manifest(root, validated_cli_version)
    path = root / MANIFEST_NAME
    _atomic_write(path, _json_bytes(manifest))
    return path


def verify_manifest(release_root):
    """Return evidence, including missing, extra, changed, or unsafe inputs."""
    root = Path(release_root)
    errors = []
    manifest = None
    raw = b""
    try:
        raw, _ = _read_regular(root / MANIFEST_NAME)
        manifest = json.loads(raw)
        if (not isinstance(manifest, dict) or manifest.get("schema") != 1
                or not isinstance(manifest.get("files"), dict)
                or not manifest["files"]):
            raise RecoveryError("Invalid release manifest structure")
        if not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("validatedCliVersion", ""))):
            raise RecoveryError("Invalid validated CLI version")
        for relative, record in manifest["files"].items():
            if not _in_scope(relative) or not isinstance(record, dict):
                raise RecoveryError("Unsafe manifest file entry")
            if (not re.fullmatch(r"[0-9a-f]{64}", str(record.get("sha256", "")))
                    or type(record.get("bytes")) is not int
                    or record["bytes"] < 0
                    or type(record.get("executable")) is not bool):
                raise RecoveryError("Invalid manifest file record")
        actual = _inventory(root, require_runtime=False)
        expected = manifest["files"]
        for relative in sorted(set(expected) - set(actual)):
            errors.append("missing: " + relative)
        for relative in sorted(set(actual) - set(expected)):
            errors.append("unexpected: " + relative)
        for relative in sorted(set(actual) & set(expected)):
            if actual[relative] != expected[relative]:
                errors.append("changed: " + relative)
    except (RecoveryError, ValueError, OSError, TypeError) as error:
        errors.append(str(error))
    return {"ok": not errors, "errors": errors,
            "manifestDigest": _digest(raw) if raw else None,
            "validatedCliVersion": manifest.get("validatedCliVersion") if isinstance(manifest, dict) else None,
            "fileCount": len(manifest.get("files", {})) if isinstance(manifest, dict) and isinstance(manifest.get("files"), dict) else 0}


def _private_dir(path):
    path = Path(path)
    if path.is_symlink():
        raise RecoveryError("Runtime directories cannot be symlinks: " + str(path))
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RecoveryError("Runtime directory is not owned by this user")
    path.chmod(0o700)


@contextlib.contextmanager
def _release_lock(runtime_root):
    root = Path(runtime_root)
    _private_dir(root)
    _private_dir(root / "releases")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(str(root / ".release.lock"), flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RecoveryError("Unsafe release lock file")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield root
    finally:
        os.close(fd)


def _read_history(root):
    path = root / "activation-history.json"
    if not path.exists() and not path.is_symlink():
        return []
    raw, _ = _read_regular(path, private=True)
    try:
        history = json.loads(raw)
        if not isinstance(history, list) or any(
            not isinstance(item, dict) or not _valid_id(item.get("releaseId"))
            for item in history
        ):
            raise ValueError()
        return history
    except (ValueError, TypeError):
        raise RecoveryError("Invalid private release activation history") from None


def _valid_id(release_id):
    return isinstance(release_id, str) and bool(_RELEASE_ID.fullmatch(release_id)) and release_id not in (".", "..")


def current_release(runtime_root):
    root = Path(runtime_root)
    current = root / "current"
    if not current.exists() and not current.is_symlink():
        return None
    if not current.is_symlink():
        raise RecoveryError("Current release pointer is not a symlink")
    target = os.readlink(str(current))
    parts = Path(target).parts
    if len(parts) != 2 or parts[0] != "releases" or not _valid_id(parts[1]):
        raise RecoveryError("Current release pointer leaves the release directory")
    release = root / target
    if release.is_symlink() or not release.is_dir():
        raise RecoveryError("Current release is missing or unsafe")
    return parts[1]


def _activate(root, release_id, history, action):
    previous = current_release(root)
    # Write-ahead history preserves a recovery record if pointer replacement is
    # interrupted. Rollback still verifies every selected release independently.
    history = history + [{"releaseId": release_id, "previousReleaseId": previous,
                          "action": action, "activationState": "prepared",
                          "activatedAt": _utc_now()}]
    _atomic_write(root / "activation-history.json", _json_bytes(history))
    temporary = root / (".current-" + uuid.uuid4().hex)
    try:
        os.symlink("releases/" + release_id, str(temporary))
        os.replace(str(temporary), str(root / "current"))
        history[-1]["activationState"] = "active"
        _atomic_write(root / "activation-history.json", _json_bytes(history))
    finally:
        if temporary.is_symlink():
            temporary.unlink()
    return {"ok": True, "releaseId": release_id, "previousReleaseId": previous,
            "action": action, "current": str(root / "current"),
            "runningJobsChanged": False}


def install_release(source_root, runtime_root, release_id=None,
                    validated_cli_version=VALIDATED_CLI_VERSION):
    """Copy a verified immutable release, then atomically select it for new jobs."""
    source = Path(source_root)
    manifest = create_manifest(source, validated_cli_version)
    if release_id is None:
        release_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
    if not _valid_id(release_id):
        raise RecoveryError("Invalid release identifier")
    with _release_lock(runtime_root) as root:
        history = _read_history(root)
        current_release(root)  # Refuse unsafe pointer before preparing anything.
        destination = root / "releases" / release_id
        if destination.exists() or destination.is_symlink():
            raise RecoveryError("Release identifiers are immutable and cannot be reused")
        stage = Path(tempfile.mkdtemp(prefix=".prepare-", dir=str(root / "releases")))
        stage.chmod(0o700)
        try:
            for relative, record in manifest["files"].items():
                data, _ = _read_regular(source / relative)
                if len(data) != record["bytes"] or _digest(data) != record["sha256"]:
                    raise RecoveryError("Source changed while preparing release: " + relative)
                output = stage / relative
                parent = stage
                for part in Path(relative).parts[:-1]:
                    parent = parent / part
                    parent.mkdir(mode=0o700, exist_ok=True)
                output.write_bytes(data)
                output.chmod(0o700 if record["executable"] else 0o600)
            _atomic_write(stage / MANIFEST_NAME, _json_bytes(manifest))
            verified = verify_manifest(stage)
            if not verified["ok"]:
                raise RecoveryError("Prepared release verification failed: " + "; ".join(verified["errors"]))
            os.rename(str(stage), str(destination))
            result = _activate(root, release_id, history, "install")
            result["verification"] = verified
            return result
        finally:
            if stage.exists():
                shutil.rmtree(str(stage))


def rollback(runtime_root, release_id=None):
    """Select a previously activated verified release; never alter job state."""
    with _release_lock(runtime_root) as root:
        current = current_release(root)
        history = _read_history(root)
        previous_ids = [event["releaseId"] for event in history
                        if event.get("activationState") == "active"
                        and event["releaseId"] != current]
        if release_id is None:
            release_id = previous_ids[-1] if previous_ids else None
        if not _valid_id(release_id) or release_id not in previous_ids:
            raise RecoveryError("Rollback requires a previously activated release other than current")
        release = root / "releases" / release_id
        if release.is_symlink() or not release.is_dir():
            raise RecoveryError("Rollback release is missing or unsafe")
        verified = verify_manifest(release)
        if not verified["ok"]:
            raise RecoveryError("Rollback release failed verification: " + "; ".join(verified["errors"]))
        result = _activate(root, release_id, history, "rollback")
        result["verification"] = verified
        return result


def check_cli_version(executable, expected_version=VALIDATED_CLI_VERSION):
    """Only call --version. A mismatch is unvalidated, not proof of breakage."""
    evidence = {"ok": False, "expectedVersion": expected_version,
                "observedVersion": None, "modelRequestMade": False}
    try:
        result = subprocess.run([str(executable), "--version"], capture_output=True,
                                text=True, timeout=15, check=False)
        match = re.fullmatch(r"\s*(\d+\.\d+\.\d+)(?:\s+\([^\r\n]*\))?\s*", result.stdout)
        if result.returncode != 0 or not match:
            evidence["status"] = "version-unavailable"
            return evidence
        evidence["observedVersion"] = match.group(1)
        evidence["ok"] = evidence["observedVersion"] == expected_version
        evidence["status"] = "validated-version" if evidence["ok"] else "unvalidated-version"
    except (OSError, subprocess.SubprocessError):
        evidence["status"] = "version-unavailable"
    return evidence


def doctor(runtime_root, executable, expected_version=None):
    evidence = {"ok": False, "checkedAt": _utc_now(),
                "modelRequestMade": False, "runningJobsChanged": False}
    try:
        release_id = current_release(runtime_root)
        if release_id is None:
            raise RecoveryError("No release is active")
        verification = verify_manifest(Path(runtime_root) / "releases" / release_id)
        evidence.update(releaseId=release_id, verification=verification)
        version = expected_version or verification["validatedCliVersion"]
        evidence["cli"] = check_cli_version(executable, version)
        evidence["ok"] = verification["ok"] and evidence["cli"]["ok"]
    except (RecoveryError, OSError, ValueError) as error:
        evidence["error"] = str(error)
    return evidence
