#!/usr/bin/env python3
"""Launch one explicitly selected native team profile; never pool or rotate logins."""
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import sys

def _configured_path(value, label):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(label + " must be an absolute path.")
    return path


def resolve_cli(environ=None, home=None):
    """Resolve a configured CLI, the current PATH, then the user-local fallback."""
    environ = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    if "NATIVE_TEAM_CLAUDE_CLI" in environ:
        return str(_configured_path(environ["NATIVE_TEAM_CLAUDE_CLI"], "Native Claude CLI"))
    located = shutil.which("claude", path=environ.get("PATH", os.defpath))
    return str(Path(located).absolute()) if located else str(home / ".local/bin/claude")


def resolve_profile_config(environ=None, home=None):
    """Locate the private mapping without opening any account configuration."""
    environ = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    if "NATIVE_TEAM_PROFILE_CONFIG" in environ:
        return _configured_path(environ["NATIVE_TEAM_PROFILE_CONFIG"], "Native profile mapping")
    return home / ".factory/config/native-ultracode-profiles.json"


CLI = resolve_cli()
CONFIG = resolve_profile_config()
PROFILES = frozenset(("team1", "team2", "team3", "team4"))
MODEL = "claude-opus-5-5"
SETTINGS = '{"ultracode":true,"workflowSizeGuideline":"small"}'
BLOCKED_FLAGS = frozenset(("-m", "--model", "--fallback-model", "--effort", "--settings", "--setting-sources", "--api-key", "--auth-token", "--oauth-token", "--access-token", "--api-key-helper", "--config-dir"))
STRIPPED_NAMES = frozenset((
    "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_GATEWAY_TOKEN", "AGENT_PROXY_AUTH_TOKEN",
    "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_CODE_API_KEY_HELPER", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_MODEL", "CLAUDE_MODEL", "CLAUDE_MODEL_ID", "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
    "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_DISABLE_WORKFLOWS",
    "CLAUDE_CODE_DISABLE_SANDBOX", "CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS",
))


class Refused(Exception):
    pass


def sanitized_env(source, config_dir):
    result = {}
    for name, value in source.items():
        if name in STRIPPED_NAMES or name.startswith(("ANTHROPIC_", "CLAUDE_CODE_USE_", "CLAUDE_CODE_OAUTH_", "CCR_")):
            continue
        if name.startswith("CLAUDE_CODE_") and name.endswith("_FILE_DESCRIPTOR"):
            continue
        result[name] = value
    result["CLAUDE_CONFIG_DIR"] = config_dir
    result["CLAUDE_CODE_EFFORT_LEVEL"] = "medium"
    return result


def profile_settings(profile):
    if profile not in PROFILES:
        raise Refused("Only team1 through team4 are configured.")
    try:
        info = CONFIG.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("not private")
        value = json.loads(CONFIG.read_text())
        item = value["profiles"][profile]
        email, config_dir = item["email"], item["configDir"]
        if not isinstance(email, str) or not email.strip() or not isinstance(config_dir, str) or not Path(config_dir).is_absolute():
            raise ValueError("invalid mapping")
        if not Path(config_dir).is_dir():
            raise ValueError("missing directory")
        return email, config_dir
    except (OSError, ValueError, TypeError, KeyError):
        raise Refused("The private native profile mapping is missing, unsafe, or incomplete.") from None


def validate_configuration(config_dir, worktree):
    """Do not let settings route an authenticated native job to a different provider."""
    candidates = [Path(config_dir) / 'settings.json',
                  Path(worktree) / '.claude' / 'settings.json',
                  Path(worktree) / '.claude' / 'settings.local.json']
    for path in candidates:
        if not path.exists() and not path.is_symlink():
            continue
        try:
            if path.is_symlink() or path.stat().st_size > 1024 * 1024:
                raise ValueError()
            value = json.loads(path.read_text())
            if not isinstance(value, dict) or value.get('apiKeyHelper'):
                raise ValueError()
            env = value.get('env', {})
            if not isinstance(env, dict):
                raise ValueError()
            for name in env:
                if name in STRIPPED_NAMES or name.startswith(('ANTHROPIC_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH_', 'CCR_')):
                    raise ValueError()
        except (OSError, ValueError, TypeError):
            raise Refused('Profile or project settings contain an unsafe provider override or malformed configuration.') from None


def validate_args(args):
    for arg in args:
        if arg.startswith("-") and not arg.startswith("--") and len(arg) > 2:
            raise Refused("Use separate short options; attached or clustered options are disabled in this launcher.")
        if arg.split("=", 1)[0] in BLOCKED_FLAGS:
            raise Refused("Model, effort, settings and authentication overrides are disabled in this launcher.")
    command_args = args[:args.index("--")] if "--" in args else args
    if any(arg in ("auth", "login", "logout", "setup-token") for arg in command_args):
        raise Refused("Use the account's normal native launcher for authentication changes.")


def verify_login(env, expected_email):
    try:
        completed = subprocess.run([CLI, "auth", "status", "--json"], env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, timeout=20, check=False)
        if completed.returncode != 0:
            raise ValueError("failed")
        result = json.loads(completed.stdout)
        if not isinstance(result, dict):
            raise ValueError("invalid status")
        if not (result.get("loggedIn") is True
                and result.get("authMethod") == "claude.ai"
                and result.get("apiProvider") == "firstParty"
                and result.get("subscriptionType") == "team"
                and isinstance(result.get("email"), str)
                and result["email"].casefold() == expected_email.casefold()):
            raise ValueError("identity mismatch")
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        raise Refused("Native login check failed: this profile must use its expected Claude Team account and first-party subscription login.") from None


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if not args:
            raise Refused("A fixed team profile is required.")
        profile = args.pop(0)
        check_only = args == ["--check"]
        if "--check" in args and not check_only:
            raise Refused("Use --check by itself after the profile name.")
        validate_args(args)
        email, config_dir = profile_settings(profile)
        env = sanitized_env(os.environ, config_dir)
        verify_login(env, email)
        if check_only:
            print(json.dumps({"profile": profile, "status": "ready", "provider": "firstParty", "subscription": "team", "model": MODEL, "effort": "medium", "ultracode": True}))
            return 0
        os.execve(CLI, [CLI, "--model", MODEL, "--effort", "medium", "--settings", SETTINGS, *args], env)
    except Refused as error:
        print(str(error), file=sys.stderr)
        return 1
    except OSError:
        print("The native Claude executable could not be launched.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
