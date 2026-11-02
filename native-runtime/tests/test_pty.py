"""Actual nested-PTY exercise; no Claude or external service is launched."""
import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]


class InteractivePtyTests(unittest.TestCase):
    def test_interactive_input_controlling_tty_and_restoration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = root / 'repo'
            repo.mkdir()
            for args in [('init', '-q'), ('config', 'user.name', 'Fixture'),
                         ('config', 'user.email', 'fixture@example.invalid')]:
                subprocess.run(['git', '-C', str(repo), *args], check=True)
            (repo / 'source.txt').write_text('unchanged\n')
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), 'commit', '-qm', 'fixture'], check=True)
            proof = root / 'proof.json'
            child_result = root / 'child.json'
            child = (
                "import json,os,sys;from pathlib import Path;"
                "tty=os.open('/dev/tty',os.O_RDWR);"
                "print('PTY_INPUT_READY',flush=True);"
                "line=sys.stdin.readline();"
                "Path(sys.argv[1]).write_text(json.dumps({'stdinTty':os.isatty(0),"
                "'stdoutTty':os.isatty(1),'controlling':os.tcgetpgrp(0)==os.getpgrp(),"
                "'input':line,'cwd':os.getcwd()}));os.close(tty);"
                "print('PTY_OUTPUT_COMPLETE',flush=True)"
            )
            supervisor = """
import json,os,sys,termios
from pathlib import Path
from native_runtime.core import RuntimeConfig
from native_runtime.supervisor import run_job
def configuration(fd):
    attrs=termios.tcgetattr(fd)
    attrs[3] &= ~getattr(termios,'PENDIN',0)
    return attrs
root=Path(sys.argv[1]); before=configuration(0)
config=RuntimeConfig(root/'state',root/'workspaces',poll_interval=.04,cancel_grace=.4)
job=run_job(config,'team1',root/'repo',lambda _j:([sys.executable,'-c',sys.argv[2],str(root/'child.json')],dict(os.environ)),timeout_seconds=8)
(root/'proof.json').write_text(json.dumps({'restored':before==configuration(0),'job':job}))
"""
            master, slave = pty.openpty()
            before = termios.tcgetattr(slave)
            # Darwin may set PENDIN after changing modes to retype pending
            # input; it is terminal state, not a failure to restore raw flags.
            before[3] &= ~getattr(termios, 'PENDIN', 0)
            process = subprocess.Popen(
                [sys.executable, '-c', supervisor, str(root), child],
                stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                env=dict(os.environ, PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE='1'),
            )
            output = bytearray()
            sent = False
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    readable, _, _ = select.select([master], [], [], .05)
                    if readable:
                        try:
                            chunk = os.read(master, 65536)
                        except OSError as error:
                            if error.errno == errno.EIO:
                                break
                            raise
                        output.extend(chunk)
                        if b'PTY_INPUT_READY' in output and not sent:
                            os.write(master, b'fixture input\n')
                            sent = True
                    if process.poll() is not None:
                        break
                self.assertIsNotNone(process.poll(), output.decode(errors='replace'))
                self.assertEqual(process.returncode, 0, output.decode(errors='replace'))
                self.assertTrue(sent, output.decode(errors='replace'))
                self.assertTrue(proof.exists(), output.decode(errors='replace'))
                result = json.loads(proof.read_text())
                observed = json.loads(child_result.read_text())
                self.assertTrue(result['restored'], json.dumps(result, indent=2))
                after = termios.tcgetattr(slave)
                after[3] &= ~getattr(termios, 'PENDIN', 0)
                self.assertEqual(after, before)
                self.assertTrue(observed['stdinTty'])
                self.assertTrue(observed['stdoutTty'])
                self.assertTrue(observed['controlling'])
                self.assertEqual(observed['input'], 'fixture input\n')
                self.assertNotEqual(observed['cwd'], str(repo))
                self.assertEqual(observed['cwd'], result['job']['worktree'])
                self.assertEqual(result['job']['state'], 'completed')
                self.assertEqual(result['job']['returnCode'], 0)
                self.assertTrue(result['job']['cleanupVerified'])
                self.assertEqual((repo / 'source.txt').read_text(), 'unchanged\n')
                saved = json.loads((root / 'state/jobs' / (result['job']['id'] + '.json')).read_text())
                self.assertEqual(saved['state'], 'completed')
                self.assertEqual(saved['sessionId'], result['job']['sessionId'])
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=3)
                process.wait()
                os.close(master)
                os.close(slave)


if __name__ == '__main__':
    unittest.main()
