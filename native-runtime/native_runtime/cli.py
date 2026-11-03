"""Native Team jobs: isolated workspaces, bounded processes and honest evidence."""
import argparse
import json
import os
from pathlib import Path
import sys

from . import auth
from .core import RuntimeConfig, RuntimeRefused, read_json
from .recovery import RecoveryError, doctor, rollback, verify_manifest, check_cli_version
from .supervisor import get_job, list_jobs, request_cancel, run_job

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
CONFIG_PATH = HOME / '.factory/config/team-runtime.json'
DEFAULTS = {
    'runtimeRoot': str(HOME / '.factory/team-runtime'),
    'stateRoot': str(HOME / '.factory/team-runtime/state'),
    'workspaceRoot': str(HOME / '.factory/team-workspaces'),
    'maxRunning': 2, 'perProfile': 1, 'timeoutSeconds': 7200,
}
VALUE_FLAGS = {'--output-format': {'text', 'json', 'stream-json'},
               '--input-format': {'text', 'stream-json'}}
BOOL_FLAGS = {'-p', '--print', '--verbose', '--no-chrome', '--include-partial-messages',
              '--replay-user-messages'}
BLOCKED_COMMANDS = {'auth', 'login', 'logout', 'setup-token', 'agents', 'attach', 'stop',
                    'kill', 'rm', 'respawn', 'update', 'upgrade', 'install', 'gateway',
                    'mcp', 'plugin', 'plugins', 'purge', 'import', 'ultrareview'}


def load_config():
    value = dict(DEFAULTS)
    if CONFIG_PATH.exists() or CONFIG_PATH.is_symlink():
        source = read_json(CONFIG_PATH)
        if set(source) - set(DEFAULTS):
            raise RuntimeRefused('Unknown runtime configuration field.')
        value.update(source)
    config = RuntimeConfig(Path(value['stateRoot']), Path(value['workspaceRoot']),
                           max_running=value['maxRunning'], per_profile=value['perProfile'])
    return config, value


def native_args(args):
    """Only permit output/prompt flags; admission and identity stay with this process."""
    args = list(args)
    if args[:1] == ['--']:
        args.pop(0)
    out, prompts = [], []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == '--':
            prompts.extend(args[i + 1:])
            break
        flag, equal, attached = arg.partition('=')
        if flag in VALUE_FLAGS:
            if not equal:
                i += 1
                if i >= len(args):
                    raise RuntimeRefused('Missing output format.')
                attached = args[i]
            if attached not in VALUE_FLAGS[flag]:
                raise RuntimeRefused('Unsupported output format.')
            out.extend([flag, attached])
        elif arg in BOOL_FLAGS:
            out.append(arg)
        elif arg.startswith('-'):
            raise RuntimeRefused('This native flag is not supported by the supervised launcher. Use team-job resume for a recorded job.')
        else:
            prompts.append(arg)
        i += 1
    if len(prompts) > 1:
        raise RuntimeRefused('Pass the initial prompt as one quoted argument.')
    if prompts and prompts[0] in BLOCKED_COMMANDS:
        raise RuntimeRefused('Administrative Claude commands belong in the normal account launcher.')
    # The end-of-options separator prevents prompt text being parsed as an option.
    return out + (['--', prompts[0]] if prompts else [])


def policy_text(workflow):
    if workflow not in ('implement', 'investigate', 'release-prepare'):
        raise RuntimeRefused('Unknown workflow.')
    return ((ROOT / 'policies/team-policy.md').read_text() + '\n\n' +
            (ROOT / 'workflows' / (workflow + '.md')).read_text())


def ensure_release():
    result = verify_manifest(ROOT)
    if not result['ok']:
        raise RuntimeRefused('Installed runtime integrity check failed; run team-job doctor.')
    return result


def prepare_builder(profile, args, workflow, validated_version='2.1.316'):
    clean_args = native_args(args)
    email, config_dir = auth.profile_settings(profile)
    env = auth.sanitized_env(os.environ, config_dir)
    # Check both before waiting and again after queue admission.
    auth.verify_login(env, email)
    def build(job):
        if not check_cli_version(auth.CLI, validated_version)['ok']:
            raise RuntimeRefused('Native CLI changed while the job was queued; run team-job update-check.')
        auth.validate_configuration(config_dir, job['worktree'])
        auth.verify_login(env, email)
        settings = {'ultracode': True, 'enableWorkflows': True, 'workflowSizeGuideline': 'small',
                    'modelSettings': {'claude-opus-5-5': {'effortLevel': 'medium'}}}
        argv = [auth.CLI, '--model', auth.MODEL, '--effort', 'medium',
                '--settings', json.dumps(settings, separators=(',', ':')),
                '--permission-mode', 'manual', '--system-prompt-snapshot', 'off',
                '--append-system-prompt', policy_text(workflow)]
        argv += ['--resume', job['sessionId']] if job.get('resume') else ['--session-id', job['sessionId']]
        return argv + clean_args, env
    return build, config_dir


def emit(value):
    print(json.dumps(value, indent=2, sort_keys=True))


def run_native(config, settings, args, existing=None):
    release = ensure_release()
    health = doctor(Path(settings['runtimeRoot']), Path(auth.CLI))
    if not health['ok']:
        raise RuntimeRefused('Runtime or native CLI version has changed; run team-job update-check before new work.')
    profile = existing['profile'] if existing else args.profile
    workflow = existing['workflow'] if existing else args.workflow
    builder, config_dir = prepare_builder(profile, args.native, workflow, release['validatedCliVersion'])
    job = run_job(config, profile, existing['repository'] if existing else args.repo, builder,
                  workflow=workflow, timeout_seconds=args.timeout or settings['timeoutSeconds'],
                  job_id=existing['id'] if existing else None,
                  base_ref=getattr(args, 'base_ref', 'HEAD'),
                  requested={'model': auth.MODEL, 'effort': 'medium', 'ultracode': True},
                  metadata={'configDir': config_dir, 'runtimeRelease': ROOT.name},
                  on_created=lambda item: print('[team-job] ' + item['id'] + ' queued; workspace: ' + item['worktree'], file=sys.stderr, flush=True))
    from .telemetry import extract_usage
    # Observation is read-only; raw conversation content never enters this output.
    summary = extract_usage(dict(job, configDir=config_dir))
    emit({'jobId': job['id'], 'state': job['state'], 'worktree': job['worktree'],
          'branch': job['branch'], 'exitCode': job.get('returnCode'), 'observed': summary})
    return 0 if job['state'] == 'completed' else 1


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    sub = root.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run')
    run.add_argument('--profile', required=True, choices=sorted(auth.PROFILES))
    run.add_argument('--repo', type=Path, default=Path.cwd())
    run.add_argument('--workflow', choices=['implement', 'investigate', 'release-prepare'], default='implement')
    run.add_argument('--timeout', type=float)
    run.add_argument('--base-ref', default='HEAD')
    resume = sub.add_parser('resume')
    resume.add_argument('job')
    resume.add_argument('--timeout', type=float)
    for name in ('status', 'report', 'doctor', 'update-check'):
        command = sub.add_parser(name)
        command.add_argument('--json', action='store_true')
        if name not in ('status', 'report'):
            command.add_argument('--profile', choices=sorted(auth.PROFILES))
    for name in ('show', 'cancel'):
        sub.add_parser(name).add_argument('job')
    check = sub.add_parser('check')
    check.add_argument('--job', required=True)
    check.add_argument('--name', required=True)
    check.add_argument('--timeout', type=float, default=600)
    restore = sub.add_parser('rollback')
    restore.add_argument('--release')
    workflow = sub.add_parser('workflow')
    workflow.add_argument('name', nargs='?', choices=['implement', 'investigate', 'release-prepare'])
    return root


def parse_invocation(argv=None):
    values = list(sys.argv[1:] if argv is None else argv)
    tail = []
    if '--' in values:
        separator = values.index('--')
        values, tail = values[:separator], values[separator + 1:]
    args = parser().parse_args(values)
    if args.command in ('run', 'resume'):
        args.native = tail
    elif args.command == 'check':
        args.argv = tail
    elif tail:
        raise RuntimeRefused('This command does not accept a trailing native command.')
    return args


def main(argv=None):
    try:
        args = parse_invocation(argv)
        config, settings = load_config()
        if args.command == 'run':
            return run_native(config, settings, args)
        if args.command == 'resume':
            return run_native(config, settings, args, get_job(config, args.job))
        if args.command in ('status', 'report'):
            if args.command == 'status':
                list_jobs(config)  # Reconcile with actual process identities first.
            from .reporting import report_jobs
            emit(report_jobs(config.state_root))
        elif args.command == 'show':
            from .telemetry import extract_usage
            job = get_job(config, args.job)
            job['configDir'] = job.get('metadata', {}).get('configDir')
            emit({'job': {k: v for k, v in job.items() if k not in ('metadata', 'configDir')},
                  'observed': extract_usage(job)})
        elif args.command == 'cancel':
            job = request_cancel(config, args.job)
            emit({'jobId': job['id'], 'state': job['state'],
                  'cancelRequested': bool(job.get('cancelRequestedAt'))})
        elif args.command == 'check':
            from .supervisor import run_check
            command = args.argv[1:] if args.argv[:1] == ['--'] else args.argv
            if not command:
                raise RuntimeRefused('A check command after -- is required.')
            result = run_check(config, args.job, args.name, command, timeout_seconds=args.timeout)
            emit(result)
            return 0 if result.get('exitCode') == 0 else 1
        elif args.command in ('doctor', 'update-check'):
            result = doctor(Path(settings['runtimeRoot']), Path(auth.CLI))
            if args.profile:
                email, folder = auth.profile_settings(args.profile)
                auth.validate_configuration(folder, Path.cwd())
                auth.verify_login(auth.sanitized_env(os.environ, folder), email)
                result['profile'] = {'name': args.profile, 'authenticated': True, 'provider': 'firstParty', 'subscription': 'team'}
            result['scope'] = 'integrity, version and optional login only; no model request'
            emit(result)
            return 0 if result['ok'] else 1
        elif args.command == 'rollback':
            emit(rollback(Path(settings['runtimeRoot']), args.release))
        elif args.command == 'workflow':
            if args.name:
                print(policy_text(args.name))
            else:
                emit({'workflows': ['implement', 'investigate', 'release-prepare']})
        return 0
    except (RuntimeRefused, RecoveryError, auth.Refused, ValueError, OSError) as error:
        # Exception text from these operations contains no child output or credentials.
        print('Team job refused: ' + str(error), file=sys.stderr)
        return 2


def fixed_profile_entry(profile, argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ['--check']:
        return main(['doctor', '--profile', profile, '--json'])
    if args in (['--version'], ['-v']):
        import subprocess
        return subprocess.call([auth.CLI, '--version'])
    options = argparse.ArgumentParser(add_help=False)
    options.add_argument('--repo', default=str(Path.cwd()))
    options.add_argument('--workflow', default='implement')
    options.add_argument('--timeout')
    selected, native = options.parse_known_args(args)
    command = ['run', '--profile', profile, '--repo', selected.repo, '--workflow', selected.workflow]
    if selected.timeout:
        command += ['--timeout', selected.timeout]
    return main(command + ['--'] + native)
