"""Validate the instruction bundle consumed by named workflow selection.

These are bundle-format and scope contracts, not tests of model compliance.
"""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PolicyBundleTests(unittest.TestCase):
    def test_named_workflows_have_matching_unique_ids(self):
        workflows = sorted((ROOT / "workflows").glob("*.md"))
        self.assertEqual({p.stem for p in workflows},
                         {"implement", "investigate", "release-prepare"})
        identifiers = []
        for path in workflows:
            self.assertFalse(path.is_symlink())
            text = path.read_text()
            match = re.match(r"\A---\nid: ([a-z-]+)\npurpose: [^\n]+\n---\n", text)
            self.assertIsNotNone(match, path.name)
            self.assertEqual(match.group(1), path.stem)
            identifiers.append(match.group(1))
        self.assertEqual(len(identifiers), len(set(identifiers)))

    def test_every_workflow_is_scoped_and_defers_to_shared_policy(self):
        for path in (ROOT / "workflows").glob("*.md"):
            text = path.read_text()
            self.assertIn("shared team execution policy", text, path.name)
            self.assertRegex(text, r"(?m)^1\. \*\*")
            self.assertIn("evidence", text.lower(), path.name)
            self.assertRegex(text.lower(), r"authori(?:s|t)", path.name)

    def test_runtime_instructions_do_not_enable_bypass_modes(self):
        for directory in ("policies", "workflows"):
            for path in (ROOT / directory).glob("*.md"):
                text = path.read_text()
                self.assertNotIn("--dangerously-skip-permissions", text)
                self.assertNotIn("permissionMode: bypassPermissions", text)
                self.assertNotIn("ANTHROPIC_API_KEY=", text)
                self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN=", text)

    def test_canonical_policy_keeps_required_qa_and_real_runner_contracts(self):
        text = (ROOT / "policies" / "team-policy.md").read_text()
        self.assertIn("~/.codex/skills/qa-with-e2e/SKILL.md", text)
        self.assertIn("~/.local/bin/lci run <profile> --pr N --post --comment", text)
        self.assertIn("One PR per repository", text)
        self.assertIn("once per branch", text)
        self.assertIn("not a hard agent", text)


if __name__ == "__main__":
    unittest.main()
