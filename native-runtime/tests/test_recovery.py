import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


MODULE = Path(__file__).parents[1] / "native_runtime" / "recovery.py"
SPEC = importlib.util.spec_from_file_location("runtime_recovery", MODULE)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        (self.source / "native_runtime").mkdir(parents=True)
        (self.source / "native_runtime" / "main.py").write_text("print('ready')\n")
        (self.source / "policies").mkdir()
        (self.source / "policies" / "shared.md").write_text("Preserve other work.\n")
        self.installed = self.root / "installed"

    def tearDown(self):
        self.temp.cleanup()

    def fake_cli(self, version="2.1.316"):
        cli = self.root / "fake-claude"
        cli.write_text("#!/bin/sh\n[ \"$1\" = \"--version\" ] || exit 99\nprintf '%s\\n' '" + version + " (Claude Code)'\n")
        cli.chmod(0o700)
        return cli

    def test_manifest_is_scoped_and_does_not_copy_secrets(self):
        (self.source / ".env").write_text("DO_NOT_COPY=secret")
        (self.source / "native_runtime" / ".env").write_text("OTHER_SECRET=secret")
        (self.source / "native_runtime" / "__pycache__").mkdir()
        (self.source / "native_runtime" / "__pycache__" / "ignored.py").write_text("secret")
        (self.source / "logs").mkdir()
        (self.source / "logs" / "debug.py").write_text("secret")
        manifest = recovery.create_manifest(self.source)
        self.assertEqual(set(manifest["files"]), {"native_runtime/main.py", "policies/shared.md"})
        installed = recovery.install_release(self.source, self.installed, "r1")
        release = self.installed / "releases" / "r1"
        self.assertTrue(installed["ok"])
        self.assertFalse((release / ".env").exists())
        self.assertFalse((release / "logs").exists())
        self.assertTrue(recovery.verify_manifest(release)["ok"])

    def test_detects_changed_missing_extra_and_executable_drift(self):
        recovery.write_manifest(self.source)
        file = self.source / "native_runtime" / "main.py"
        file.write_text("changed\n")
        self.assertIn("changed: native_runtime/main.py", recovery.verify_manifest(self.source)["errors"])
        file.unlink()
        self.assertIn("missing: native_runtime/main.py", recovery.verify_manifest(self.source)["errors"])
        file.write_text("print('ready')\n")
        file.chmod(0o700)
        self.assertIn("changed: native_runtime/main.py", recovery.verify_manifest(self.source)["errors"])
        (self.source / "native_runtime" / "new.py").write_text("pass\n")
        self.assertIn("unexpected: native_runtime/new.py", recovery.verify_manifest(self.source)["errors"])

    def test_rejects_source_symlinks_and_nonregular_inputs(self):
        file = self.source / "native_runtime" / "main.py"
        file.unlink()
        file.symlink_to(self.source / "policies" / "shared.md")
        with self.assertRaises(recovery.RecoveryError):
            recovery.create_manifest(self.source)
        file.unlink()
        os.mkfifo(file)
        with self.assertRaises(recovery.RecoveryError):
            recovery.create_manifest(self.source)
        file.unlink()
        (self.source / "native_runtime" / "linked").symlink_to(self.source / "policies", target_is_directory=True)
        with self.assertRaises(recovery.RecoveryError):
            recovery.create_manifest(self.source)

    def test_rejects_manifest_path_traversal(self):
        manifest = recovery.create_manifest(self.source)
        manifest["files"]["../secrets.py"] = dict(next(iter(manifest["files"].values())))
        (self.source / recovery.MANIFEST_NAME).write_text(json.dumps(manifest))
        result = recovery.verify_manifest(self.source)
        self.assertFalse(result["ok"])
        self.assertIn("Unsafe manifest file entry", result["errors"])

    def test_install_private_immutable_and_atomic_selection(self):
        nested = self.source / "native_runtime" / "nested" / "deeper"
        nested.mkdir(parents=True)
        (nested / "module.py").write_text("pass\n")
        result = recovery.install_release(self.source, self.installed, "r1")
        self.assertIsNone(result["previousReleaseId"])
        self.assertEqual(os.readlink(self.installed / "current"), "releases/r1")
        self.assertEqual(stat.S_IMODE(self.installed.stat().st_mode), 0o700)
        release = self.installed / "releases" / "r1"
        for path in release.rglob("*"):
            if path.is_file():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            if path.is_dir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        with self.assertRaises(recovery.RecoveryError):
            recovery.install_release(self.source, self.installed, "r1")
        self.assertEqual(recovery.current_release(self.installed), "r1")

    def test_rollback_verified_previous_release_preserves_state(self):
        recovery.install_release(self.source, self.installed, "r1")
        (self.source / "native_runtime" / "main.py").write_text("print('next')\n")
        recovery.install_release(self.source, self.installed, "r2")
        jobs = self.installed / "jobs.json"
        jobs.write_text('{"job":"running"}')
        result = recovery.rollback(self.installed)
        self.assertEqual(result["releaseId"], "r1")
        self.assertEqual(result["previousReleaseId"], "r2")
        self.assertFalse(result["runningJobsChanged"])
        self.assertEqual(jobs.read_text(), '{"job":"running"}')
        self.assertTrue((self.installed / "releases" / "r2").exists())

    def test_rollback_rejects_unknown_tampered_and_pending_releases(self):
        recovery.install_release(self.source, self.installed, "r1")
        with self.assertRaises(recovery.RecoveryError):
            recovery.rollback(self.installed)
        recovery.install_release(self.source, self.installed, "r2")
        with self.assertRaises(recovery.RecoveryError):
            recovery.rollback(self.installed, "unknown")
        history_path = self.installed / "activation-history.json"
        history = json.loads(history_path.read_text())
        history[0]["activationState"] = "prepared"
        history_path.write_text(json.dumps(history))
        with self.assertRaises(recovery.RecoveryError):
            recovery.rollback(self.installed, "r1")
        history[0]["activationState"] = "active"
        history_path.write_text(json.dumps(history))
        (self.installed / "releases" / "r1" / "native_runtime" / "main.py").write_text("tampered")
        with self.assertRaises(recovery.RecoveryError):
            recovery.rollback(self.installed, "r1")
        self.assertEqual(recovery.current_release(self.installed), "r2")

    def test_bad_preparation_does_not_change_current_pointer(self):
        recovery.install_release(self.source, self.installed, "r1")
        with mock.patch.object(recovery, "verify_manifest", return_value={"ok": False, "errors": ["test rejection"]}):
            with self.assertRaises(recovery.RecoveryError):
                recovery.install_release(self.source, self.installed, "r2")
        self.assertEqual(recovery.current_release(self.installed), "r1")
        self.assertFalse((self.installed / "releases" / "r2").exists())
        self.assertFalse(list((self.installed / "releases").glob(".prepare-*")))

    def test_failed_pointer_switch_is_not_a_rollback_candidate(self):
        recovery.install_release(self.source, self.installed, "r1")
        real_replace = recovery.os.replace

        def fail_pointer(source, target):
            if Path(target) == self.installed / "current":
                raise OSError("simulated pointer failure")
            return real_replace(source, target)

        with mock.patch.object(recovery.os, "replace", side_effect=fail_pointer):
            with self.assertRaises(OSError):
                recovery.install_release(self.source, self.installed, "r2")
        self.assertEqual(recovery.current_release(self.installed), "r1")
        with self.assertRaises(recovery.RecoveryError):
            recovery.rollback(self.installed, "r2")

    def test_rejects_unsafe_current_pointer_and_history(self):
        self.installed.mkdir()
        (self.installed / "current").symlink_to("../source")
        with self.assertRaises(recovery.RecoveryError):
            recovery.install_release(self.source, self.installed, "r1")
        (self.installed / "current").unlink()
        (self.installed / "activation-history.json").symlink_to(self.source / "policies" / "shared.md")
        with self.assertRaises(recovery.RecoveryError):
            recovery.install_release(self.source, self.installed, "r1")

    def test_cli_version_and_doctor_make_only_version_call(self):
        cli = self.fake_cli()
        recovery.install_release(self.source, self.installed, "r1")
        result = recovery.doctor(self.installed, cli)
        self.assertTrue(result["ok"])
        self.assertEqual(result["cli"]["observedVersion"], "2.1.316")
        self.assertFalse(result["modelRequestMade"])
        self.fake_cli("2.1.999")
        result = recovery.doctor(self.installed, cli)
        self.assertFalse(result["ok"])
        self.assertEqual(result["cli"]["status"], "unvalidated-version")
        self.assertTrue(result["verification"]["ok"])

    def test_version_failure_does_not_emit_captured_output(self):
        cli = self.root / "fake-claude"
        cli.write_text("#!/bin/sh\necho 'sensitive unexpected output'\nexit 1\n")
        cli.chmod(0o700)
        result = recovery.check_cli_version(cli)
        self.assertFalse(result["ok"])
        self.assertNotIn("sensitive", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
