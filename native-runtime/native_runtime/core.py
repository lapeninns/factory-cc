"""Private state and observed process identities for native team jobs."""
import contextlib
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


class RuntimeRefused(RuntimeError):
    pass


@dataclass
class RuntimeConfig:
    state_root: Path
    workspace_root: Path
    max_running: int = 2
    per_profile: int = 1
    poll_interval: float = 0.1
    cancel_grace: float = 3.0

    def __post_init__(self):
        self.state_root = Path(self.state_root).expanduser().absolute()
        self.workspace_root = Path(self.workspace_root).expanduser().absolute()
        if not 1 <= self.max_running <= 8 or self.per_profile != 1:
            raise RuntimeRefused("Concurrency must be 1..8 globally and one job per profile.")
        if not 0.02 <= self.poll_interval <= 5 or not 0.1 <= self.cancel_grace <= 30:
            raise RuntimeRefused("Invalid supervisor polling or cancellation bounds.")


def now():
    return datetime.now(timezone.utc).isoformat()


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}", value):
        raise RuntimeRefused("Invalid job ID.")
    return value


def private_dir(path):
    path = Path(path)
    # Parent directories may be ordinary user directories, but must not redirect.
    for ancestor in [path, *path.parents]:
        if ancestor.is_symlink():
            raise RuntimeRefused("Runtime paths cannot contain symlinks.")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeRefused("Runtime directories must be owned by this user and private (0700).")
    return path


def initialize(config):
    private_dir(config.state_root)
    private_dir(config.state_root / "jobs")
    private_dir(config.workspace_root)


def atomic_json(path, value):
    path = Path(path)
    private_dir(path.parent)
    if path.is_symlink():
        raise RuntimeRefused("Refusing a symlink state file.")
    fd, name = tempfile.mkstemp(prefix=".state-", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, str(path))
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path):
    path = Path(path)
    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 2 * 1024 * 1024:
                raise RuntimeRefused("Unsafe or oversized state file.")
            value = json.load(stream)
        if not isinstance(value, dict):
            raise RuntimeRefused("Invalid job state.")
        return value
    except (ValueError, OSError) as exc:
        raise RuntimeRefused("State is missing, unsafe or malformed.") from exc


@contextlib.contextmanager
def state_lock(config):
    initialize(config)
    path = config.state_root / ".lock"
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeRefused("Unsafe runtime lock.")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def job_path(config, job_id):
    return config.state_root / "jobs" / (safe_id(job_id) + ".json")


def read_job(config, job_id):
    return read_json(job_path(config, job_id))


def write_job(config, job):
    job["updatedAt"] = now()
    atomic_json(job_path(config, job["id"]), job)


def process_table():
    """No command lines or environment values enter this process snapshot."""
    try:
        result = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,lstart="],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, timeout=5, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
        if result.returncode:
            raise RuntimeRefused("Process identities could not be observed.")
        table = {}
        for line in result.stdout.splitlines():
            fields = line.split(None, 5)
            if len(fields) != 6 or fields[4].startswith("Z"):
                continue
            try:
                pid, ppid, pgid, uid = map(int, fields[:4])
            except ValueError:
                continue
            table[pid] = {"pid": pid, "ppid": ppid, "pgid": pgid, "uid": uid, "start": fields[5].strip()}
        return table
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeRefused("Process identities could not be observed.") from exc


def process_identity(pid):
    item = process_table().get(int(pid))
    return stable_identity(item) if item else None


def stable_identity(item):
    return {key: item[key] for key in ("pid", "pgid", "uid", "start")}


def matches(identity, table=None):
    if not identity or not isinstance(identity, dict):
        return False
    current = (process_table() if table is None else table).get(identity.get("pid"))
    return bool(current and stable_identity(current) == identity and identity.get("uid") == os.getuid())


def group_members(pgid, table=None):
    return [stable_identity(item) for item in (process_table() if table is None else table).values()
            if item["pgid"] == pgid and item["uid"] == os.getuid()]


def descendants(identities, table=None):
    """Extend observed ancestry, retaining only identities still matching this boot."""
    table = process_table() if table is None else table
    pids = {item["pid"] for item in identities if matches(item, table)}
    while True:
        added = {pid for pid, item in table.items() if item["ppid"] in pids and item["uid"] == os.getuid()}
        if added <= pids:
            break
        pids.update(added)
    return [stable_identity(table[pid]) for pid in sorted(pids)]
