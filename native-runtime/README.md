# Native Team job runtime

Python 3.9+ standard-library runtime for supervised native jobs and Factory Workstream leases.
It adds isolated Git worktrees, per-profile admission within worker and controller queues,
supervised execution, privacy-preserving reports, shared policy/workflows and
versioned releases. Standalone native launchers support the assigned `team1`
through `team4` profiles. The shared Factory lease helper also accounts for
`team5` through `team8`; bridge configuration determines fixed-seat versus pool
routing and the permitted workspace policy.

The default scheduler admits two worker jobs plus one reserved Factory
controller. Each profile can run one worker and one controller concurrently.
Workspace conflicts apply across both queues, and uncertain cleanup blocks
reuse of the affected profile until it is resolved.

Read [the operations guide](docs/OPERATIONS.md) for commands, policy and limits.

## Check this source

```sh
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -W error::ResourceWarning -m unittest discover -s tests -v
```

Tests use disposable repositories and fake child commands. They do not use
Claude credentials or make model requests. Live validation is a separate,
explicit check on an authorised seat.

## Install this source

```sh
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m native_runtime.install --source "$PWD"
```

Installation runs the local tests, creates a private backup receipt, installs
an immutable verified release, and selects it atomically for future jobs.
Existing runtime jobs keep their loaded code. The four preset launchers and
`team-job` use the selected release. No provider, billing, service, account
login, model request or production deployment is performed by installation.

The first release validates native Claude Code 2.1.316. Changing that version
requires checking the new version and validating a release against it; the
runtime intentionally fails new admissions for an unvalidated version.

Git worktree and process boundaries protect concurrent managed jobs. They do
not isolate people sharing one macOS login or contain malicious processes.
Model instructions remain distinct from OS and repository security controls.

## Source and configuration

This directory bundles the native runtime from source commit
`aaa826ba8354610b916dc6fd25b31c0bd96d44f3` for the bridge's optional supervised
Workstream integration. Install from this directory, then pass the installed
release directory to the bridge's `--runtime-path` / `nativeRuntimePath` setting.
The package layout must retain `native_runtime/` immediately below that path.

The standalone launcher finds `claude` on `PATH`, falling back to
`~/.local/bin/claude`. Set `NATIVE_TEAM_CLAUDE_CLI` to an absolute executable path
to override this. Its private profile mapping defaults to
`~/.factory/config/native-ultracode-profiles.json`; set
`NATIVE_TEAM_PROFILE_CONFIG` to another absolute path if required. The mapping
must remain an owned regular file with private permissions (0600). These
settings select local files; they do not create or copy credentials. The
standalone installer does not provision Factory services or eight account
logins. Keep private mappings, account state, service tokens, logs and backups
outside this source tree.
