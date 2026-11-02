import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from native_runtime.core import RuntimeConfig, RuntimeRefused, initialize
from native_runtime.workspace import create_workspace, validate_workspace


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        (self.repo / "file.txt").write_text("committed\n")
        (self.repo / ".gitignore").write_text(".env\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.config = RuntimeConfig(self.root / "state", self.root / "workspaces")
        initialize(self.config)

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def test_separate_workspaces_preserve_dirty_and_secret_source(self):
        (self.repo / "file.txt").write_text("unrelated local edit\n")
        (self.repo / ".env").write_text("DUMMY_SECRET=do-not-copy\n")
        (self.repo / "untracked.txt").write_text("untracked\n")
        one = create_workspace(self.config, self.repo, "first")
        two = create_workspace(self.config, self.repo, "second")
        self.assertNotEqual(one["worktree"], two["worktree"])
        self.assertNotEqual(one["branch"], two["branch"])
        for value in (one, two):
            value["id"] = Path(value["worktree"]).name
            workspace = validate_workspace(self.config, value)
            self.assertEqual((workspace / "file.txt").read_text(), "committed\n")
            self.assertFalse((workspace / ".env").exists())
            self.assertFalse((workspace / "untracked.txt").exists())
            self.assertEqual(workspace.stat().st_mode & 0o777, 0o700)
            self.assertTrue(value["sourceDirty"])
        (Path(one["worktree"]) / "file.txt").write_text("job one\n")
        self.assertEqual((Path(two["worktree"]) / "file.txt").read_text(), "committed\n")
        self.assertEqual((self.repo / "file.txt").read_text(), "unrelated local edit\n")

    def test_reject_subdirectory_nonrepo_reference_and_preexisting_destination(self):
        (self.repo / "nested").mkdir()
        for path in (self.repo / "nested", self.root):
            with self.assertRaises(RuntimeRefused):
                create_workspace(self.config, path, "job")
        with self.assertRaises(RuntimeRefused):
            create_workspace(self.config, self.repo, "job", "--help")
        create_workspace(self.config, self.repo, "job")
        with self.assertRaises(RuntimeRefused):
            create_workspace(self.config, self.repo, "job")

    def test_branch_drift_refuses_resume(self):
        value = create_workspace(self.config, self.repo, "job")
        value["id"] = "job"
        subprocess.run(["git", "-C", value["worktree"], "checkout", "-qb", "changed"], check=True)
        with self.assertRaises(RuntimeRefused):
            validate_workspace(self.config, value)

    def test_paths_must_be_private_and_not_redirected(self):
        self.config.state_root.chmod(0o755)
        with self.assertRaises(RuntimeRefused):
            initialize(self.config)
        self.config.state_root.chmod(0o700)
        target = self.root / "target"
        target.mkdir(mode=0o700)
        link = self.root / "redirect"
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(RuntimeRefused):
            initialize(RuntimeConfig(link, self.root / "new-workspaces"))


if __name__ == "__main__":
    unittest.main()
