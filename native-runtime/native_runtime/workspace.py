"""Create and validate committed-source workspaces without touching user edits."""
import os
from pathlib import Path
import stat
import subprocess

from .core import RuntimeRefused, private_dir, safe_id


def git(repo, *args, timeout=30):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.path.expanduser("~"),
           "LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
    try:
        result = subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                                 "-C", str(repo), *args], env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeRefused("Git was unavailable or exceeded the workspace deadline.") from exc
    if result.returncode:
        # Do not include arbitrary repository output in operational records.
        raise RuntimeRefused("Git workspace operation failed; source work was preserved.")
    return result.stdout.strip()


def validate_repo(repo):
    source = Path(repo).expanduser()
    if not source.is_absolute():
        raise RuntimeRefused("An absolute repository path is required.")
    source = source.resolve(strict=True)
    info = source.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeRefused("Repository must be a directory owned by this user.")
    root = Path(git(source, "rev-parse", "--show-toplevel")).resolve()
    if root != source:
        raise RuntimeRefused("Use the repository root, not a subdirectory.")
    if git(source, "rev-parse", "--is-bare-repository") != "false":
        raise RuntimeRefused("A non-bare Git repository is required.")
    return source


def create_workspace(config, repo, job_id, base_ref="HEAD"):
    source = validate_repo(repo)
    safe_id(job_id)
    if not isinstance(base_ref, str) or not base_ref or base_ref.startswith("-") or "\x00" in base_ref:
        raise RuntimeRefused("Invalid source reference.")
    commit = git(source, "rev-parse", "--verify", base_ref + "^{commit}")
    if len(commit) not in (40, 64) or any(ch not in "0123456789abcdef" for ch in commit):
        raise RuntimeRefused("Could not resolve an exact source commit.")
    root = private_dir(config.workspace_root)
    destination = root / job_id
    if destination.exists() or destination.is_symlink():
        raise RuntimeRefused("The allocated workspace path already exists.")
    branch = "native/" + job_id
    git(source, "worktree", "add", "-b", branch, str(destination), commit)
    os.chmod(destination, 0o700)
    return {"repository": str(source), "worktree": str(destination), "branch": branch,
            "sourceCommit": commit, "sourceRef": base_ref,
            "sourceDirty": bool(git(source, "status", "--porcelain", "--untracked-files=normal")),
            "workspacePolicy": "committed source only; source edits and untracked files were not copied"}


def validate_workspace(config, job):
    path = Path(job["worktree"])
    expected = config.workspace_root / safe_id(job.get("workspaceOwnerId", job["id"]))
    if path != expected or path.is_symlink() or not path.is_dir() or path.resolve() != expected.resolve():
        raise RuntimeRefused("Recorded workspace is missing or redirected.")
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeRefused("Workspace ownership or permissions changed.")
    if Path(git(path, "rev-parse", "--show-toplevel")).resolve() != path.resolve():
        raise RuntimeRefused("Recorded job path is not its own Git worktree.")
    if git(path, "symbolic-ref", "--short", "HEAD") != job["branch"]:
        raise RuntimeRefused("Job workspace branch changed; explicit recovery is required.")
    source = validate_repo(job["repository"])
    common = Path(git(path, "rev-parse", "--git-common-dir"))
    common = (path / common).resolve() if not common.is_absolute() else common.resolve()
    source_common = Path(git(source, "rev-parse", "--git-common-dir"))
    source_common = (source / source_common).resolve() if not source_common.is_absolute() else source_common.resolve()
    if common != source_common:
        raise RuntimeRefused("Workspace no longer belongs to its recorded repository.")
    return path
