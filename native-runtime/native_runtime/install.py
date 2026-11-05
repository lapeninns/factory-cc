"""Test and install a versioned runtime, preserving unrelated user settings."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import uuid

from .recovery import install_release, verify_manifest, RecoveryError, check_cli_version

BEGIN = '<!-- BEGIN MANAGED TEAM RUNTIME -->'
END = '<!-- END MANAGED TEAM RUNTIME -->'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def managed_text(existing, block):
    if BEGIN in existing or END in existing:
        if existing.count(BEGIN) != 1 or existing.count(END) != 1:
            raise ValueError('Ambiguous managed policy markers; preserve file for review.')
        before, rest = existing.split(BEGIN, 1)
        _, after = rest.split(END, 1)
        return before + block + after
    return existing.rstrip() + '\n\n' + block + '\n'


def _write(path, data, expected, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or (path.exists() and (not path.is_file() or path.stat().st_uid != os.getuid())):
        raise ValueError('Unsafe installation target: ' + str(path))
    present = path.read_bytes() if path.exists() else None
    if present != expected:
        raise ValueError('Installation target changed; concurrent edits preserved: ' + str(path))
    fd, temporary = tempfile.mkstemp(prefix='.team-install-', dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare_changes(home):
    base = home / '.factory/team-runtime'
    pointer = base / 'current'
    block = (BEGIN + '\n# Shared native and Factory execution policy\n\n'
             'Before starting a task, read and apply `' + str(pointer / 'policies/team-policy.md') + '`.\n'
             'Use the matching guide under `' + str(pointer / 'workflows') + '`: '
             '`implement.md`, `investigate.md`, or `release-prepare.md`.\n'
             'The task\'s explicit authority, execution surface and repository instructions remain binding.\n'
             'For a supervised native job, its recorded worktree is the assigned workspace, even when\n'
             'it is outside the usual source-checkout directory. Keep QA/e2e and final-head Local CI\n'
             'requirements; never infer release or deployment from a successful job exit.\n' + END)
    changes = {}
    # Native jobs receive the exact policy in their system instructions. Preserve
    # profile CLAUDE.md links: several profiles may intentionally share one file.
    docs = [home / '.factory/AGENTS.md']
    for path in docs:
        old = path.read_bytes() if path.exists() else None
        changes[path] = managed_text((old or b'').decode(), block).encode()
    import_prefix = ('#!/usr/bin/python3\nimport sys\nfrom pathlib import Path\n'
                     'sys.path.insert(0, str(Path(' + repr(str(pointer)) + ').resolve(strict=True)))\n')
    changes[home / '.local/bin/team-job'] = (import_prefix + 'from native_runtime.cli import main\nraise SystemExit(main())\n').encode()
    changes[home / '.factory/tools/native-team-ultracode.py'] = (import_prefix +
        'from native_runtime.cli import fixed_profile_entry\n'
        'if len(sys.argv) < 2:\n    raise SystemExit("A fixed profile is required.")\n'
        'raise SystemExit(fixed_profile_entry(sys.argv[1], sys.argv[2:]))\n').encode()
    for n in range(1, 9):
        changes[home / '.local/bin' / ('claude-team' + str(n) + '-ultracode')] = (
            '#!/bin/sh\nexec /usr/bin/python3 ' + repr(str(home / '.factory/tools/native-team-ultracode.py')) +
            ' team' + str(n) + ' "$@"\n').encode()
    config = home / '.factory/config/team-runtime.json'
    if not config.exists():
        changes[config] = (json.dumps({'runtimeRoot': str(base), 'stateRoot': str(base / 'state'),
                                     'workspaceRoot': str(home / '.factory/team-workspaces'),
                                     'maxRunning': 2, 'perProfile': 1, 'timeoutSeconds': 7200}, indent=2) + '\n').encode()
    operations = home / '.factory/tools/operations-status.py'
    if operations.exists():
        original = operations.read_text()
        marker = '# BEGIN MANAGED NATIVE SNAPSHOT'
        if marker not in original:
            anchor = '\ndef snapshot('
            index = original.find(anchor)
            if index < 0 or "'warnings': warnings," not in original:
                raise ValueError('Unknown operations-status layout; refusing an unsafe patch.')
            function = ('\n' + marker + '\ndef native_jobs_snapshot():\n'
                        '    try:\n'
                        '        result = subprocess.run(["/usr/bin/python3", ' + repr(str(home / '.local/bin/team-job')) + ', "report"],\n'
                        '                                capture_output=True, text=True, timeout=15, check=False)\n'
                        '        if result.returncode == 0:\n'
                        '            return json.loads(result.stdout)\n'
                        '    except (OSError, ValueError, subprocess.TimeoutExpired):\n'
                        '        pass\n'
                        '    return {"available": False, "reason": "native job snapshot unavailable"}\n'
                        '# END MANAGED NATIVE SNAPSHOT\n')
            original = original[:index] + function + original[index:]
            original = original.replace("'warnings': warnings,", "'nativeTeamJobs': native_jobs_snapshot(), 'warnings': warnings,", 1)
            changes[operations] = original.encode()
    return changes


def install(source, home, release_id=None, run_tests=True, validated_cli_version='2.1.316'):
    source, home = Path(source).resolve(), Path(home).resolve()
    if run_tests:
        env = dict(os.environ, PYTHONPATH=str(source), PYTHONDONTWRITEBYTECODE='1')
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(source / 'tests'), '-v'],
                       cwd=str(source), env=env, check=True)
    changes = prepare_changes(home)
    previous, modes = {}, {}
    for path in changes:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError('Unsafe installation target: ' + str(path))
        previous[path] = path.read_bytes() if path.exists() else None
        modes[path] = stat.S_IMODE(path.stat().st_mode) if path.exists() else None
    backup = home / '.factory/backups' / ('team-runtime-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True, mode=0o700)
    records = []
    for number, (path, content) in enumerate(previous.items()):
        saved = backup / ('file-' + str(number)) if content is not None else None
        if saved:
            _write(saved, content, None, 0o600)
        records.append({'path': str(path), 'backup': str(saved) if saved else None,
                        'beforeSha256': digest(content) if content is not None else None,
                        'beforeMode': modes[path],
                        'afterSha256': digest(changes[path])})
    receipt_path = backup / 'installation-receipt.json'
    prepared = (json.dumps({'schemaVersion': 1, 'state': 'prepared', 'files': records,
                            'backupDirectory': str(backup)}, indent=2) + '\n').encode()
    _write(receipt_path, prepared, None, 0o600)
    result = install_release(source, home / '.factory/team-runtime', release_id, validated_cli_version)
    receipt = {'schemaVersion': 1, 'state': 'installed', 'installedAt': datetime.now(timezone.utc).isoformat(),
               'release': result, 'files': records, 'backupDirectory': str(backup),
               'accountCredentialsCopied': False, 'factoryBridgeRestarted': False}
    applied = []
    try:
        for path, data in changes.items():
            executable = path.name == 'team-job' or path.suffix == '.py' or path.name.startswith('claude-team')
            mode = 0o755 if executable else (stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600)
            _write(path, data, previous[path], mode)
            applied.append(path)
        _write(receipt_path, (json.dumps(receipt, indent=2) + '\n').encode(), prepared, 0o600)
    except Exception:
        # Restore only files still equal to our just-written bytes.
        for path in reversed(applied):
            if path.read_bytes() == changes[path]:
                if previous[path] is None:
                    path.unlink()
                else:
                    _write(path, previous[path], changes[path], modes[path])
        active = home / '.factory/team-runtime/current'
        if active.is_symlink() and active.resolve().name == result['releaseId']:
            if result.get('previousReleaseId'):
                from .recovery import rollback
                rollback(home / '.factory/team-runtime', result['previousReleaseId'])
            else:
                active.unlink()
        raise
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--release')
    parser.add_argument('--validated-cli-version', default='2.1.316')
    args = parser.parse_args()
    if not check_cli_version(args.home / '.local/bin/claude', args.validated_cli_version)['ok']:
        parser.error('Installed Claude version does not match the selected validation baseline.')
    result = install(args.source, args.home, args.release, validated_cli_version=args.validated_cli_version)
    print(json.dumps({'releaseId': result['release']['releaseId'], 'backupDirectory': result['backupDirectory']}, indent=2))


if __name__ == '__main__':
    main()
