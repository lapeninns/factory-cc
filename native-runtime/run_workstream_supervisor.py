"""Hold a kernel lock across exec; a crashed supervisor cannot leave a stale lock."""
import fcntl
import os
import stat
import sys

if len(sys.argv) not in (5, 6) or sys.argv[3] != '--config':
    raise SystemExit('Use: launcher /absolute/node /absolute/supervisor.js --config /absolute/config.json [--once]')
node, script, _, config = sys.argv[1:5]
if not all(os.path.isabs(p) for p in (node, script, config)):
    raise SystemExit('Absolute paths required')
import json
with open(config, encoding='utf8') as source:
    state_dir = json.load(source)['stateDir']
if os.path.realpath(state_dir) != state_dir:
    raise SystemExit('Noncanonical state directory')
fd = os.open(os.path.join(state_dir, 'supervisor.lock'), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
    raise SystemExit('Unsafe lock')
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit('Another supervisor owns this target')
os.set_inheritable(fd, True)
os.environ['BRIDGE_SUPERVISOR_LOCK_FD'] = str(fd)
os.execv(node, [node, script, '--config', config] + sys.argv[5:])
