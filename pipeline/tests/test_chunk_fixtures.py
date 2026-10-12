"""Fixture tests for chunk boundaries. Run from the repo root:

    python -m unittest discover tests

Each file in ``tests/fixtures/`` is a small, fictional issue or discussion
record in the format that fetch_github.py writes. The tests pass it through
build_passages() and check the passages: token budget, speaker integrity,
source links, code names, fenced blocks, and empty input. Word counts stand
in for tokens so the tests are deterministic; one test uses tiktoken when it
is installed.
"""

import json
import unittest
from pathlib import Path

import chunk_passages as cp

FIXTURES = Path(__file__).parent / "fixtures"


def words(text):
    return len(text.split())


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


class FixtureTests(unittest.TestCase):
    def assert_within_budget(self, passages, max_tokens, count=words):
        for passage in passages:
            self.assertLessEqual(count(passage["text"]), max_tokens, passage["passage_id"])
            self.assertLessEqual(passage["token_count"], max_tokens, passage["passage_id"])

    def test_short_comment_is_one_passage_with_its_source(self):
        record = load("short_comment")
        passages, _ = cp.build_passages(record, 512, words)
        comment = [p for p in passages if p["comment_id"] == 123]
        self.assertEqual(len(comment), 1)
        self.assertEqual(comment[0]["text"], record["comments"][0]["body"])
        self.assertEqual(comment[0]["source_url"],
                         "https://github.com/example/project/issues/1#issuecomment-123")
        self.assertEqual(comment[0]["author"], "bob")
        self.assertEqual(comment[0]["title"], "Replace the legacy API")
        self.assertEqual(comment[0]["locator"], "Comment 1 of 1")
        self.assertEqual(comment[0]["chunk_count"], 1)

    def test_long_comment_splits_within_budget_and_loses_nothing(self):
        record = load("long_comment")
        passages, _ = cp.build_passages(record, 40, words)
        parts = [p for p in passages if p["comment_id"] == 900]
        self.assertGreater(len(parts), 1)
        self.assert_within_budget(parts, 40)
        body = record["comments"][0]["body"]
        self.assertEqual(" ".join(p["text"] for p in parts).split(), body.split())
        self.assertEqual([p["chunk_index"] for p in parts], list(range(len(parts))))
        self.assertTrue(all(p["chunk_count"] == len(parts) for p in parts))
        self.assertEqual(parts[0]["locator"], f"Comment 1 of 1 (part 1 of {len(parts)})")
        for p in parts:
            self.assertEqual(p["source_url"], record["comments"][0]["html_url"])
            self.assertEqual(p["author"], "ann")
            self.assertEqual(p["title"], "Scheduler rewrite")

    def test_long_comment_respects_a_real_token_budget(self):
        try:
            import tiktoken
        except ImportError:
            self.skipTest("tiktoken is not installed")
        encoding = tiktoken.get_encoding("cl100k_base")

        def count(text):
            return len(encoding.encode(text, disallowed_special=()))

        passages, _ = cp.build_passages(load("long_comment"), 64, count)
        self.assertGreater(len(passages), 1)
        self.assert_within_budget(passages, 64, count)

    def test_separate_speakers_are_never_merged(self):
        record = load("separate_speakers")
        passages, _ = cp.build_passages(record, 512, words)
        comments = [p for p in passages if p["source_unit"] == "comment"]
        self.assertEqual([p["author"] for p in comments], ["ann", "bob"])
        self.assertEqual([p["comment_id"] for p in comments], [11, 12])
        ann_text, bob_text = (c["body"] for c in record["comments"])
        for p in comments:
            self.assertFalse(ann_text in p["text"] and bob_text in p["text"], p["text"])
        self.assertNotEqual(comments[0]["source_url"], comments[1]["source_url"])

    def test_empty_comments_produce_no_passages(self):
        passages, skipped = cp.build_passages(load("empty_comment"), 512, words)
        self.assertEqual(skipped, 3)
        self.assertEqual([p["source_unit"] for p in passages], ["opening_body"])
        self.assertTrue(all(p["text"].strip() for p in passages))

    def test_code_name_is_preserved_in_every_form(self):
        passages, _ = cp.build_passages(load("code_name"), 512, words)
        joined = "\n".join(p["text"] for p in passages)
        self.assertEqual(joined.count("AutoMaterializePolicy"), 5)
        self.assertIn("`AutoMaterializePolicy`", joined)
        self.assertIn("AutoMaterializePolicy.eager()", joined)
        self.assertIn("auto_materialize_policy=AutoMaterializePolicy.lazy()", joined)
        self.assertNotIn("**", joined)

    def test_fenced_block_stays_intact_when_it_fits(self):
        passages, _ = cp.build_passages(load("fenced_block"), 512, words)
        small = [p for p in passages if p["comment_id"] == 1]
        self.assertEqual(len(small), 1)
        self.assertIn("```yaml\nscheduler:\n  kind: tick\n  interval: 30s\n```", small[0]["text"])

    def test_oversized_fenced_block_splits_into_fenced_parts(self):
        record = load("fenced_block")
        passages, _ = cp.build_passages(record, 12, words)
        parts = [p for p in passages if p["comment_id"] == 2]
        self.assertGreater(len(parts), 1)
        self.assert_within_budget(parts, 12)
        expected_lines = [l for l in record["comments"][1]["body"].split("\n") if l.startswith("step_")]
        kept_lines = [l for p in parts for l in p["text"].split("\n") if l.startswith("step_")]
        self.assertEqual(kept_lines, expected_lines)
        for p in parts:
            if "step_" in p["text"]:
                self.assertTrue(p["text"].startswith("```text\n"), p["text"])
                self.assertTrue(p["text"].endswith("\n```"), p["text"])

    def test_permalink_is_kept_on_every_passage(self):
        record = load("permalink")
        passages, _ = cp.build_passages(record, 20, words)
        parts = [p for p in passages if p["comment_id"] == 777]
        self.assertGreater(len(parts), 1)
        link = "https://github.com/example/project/issues/9#issuecomment-777"
        self.assertTrue(all(p["source_url"] == link for p in parts))
        blob = "https://github.com/example/project/blob/0a1b2c3d/src/scheduler/policy.py#L42-L57"
        self.assertEqual(sum(blob in p["text"] for p in parts), 1)

    def test_lead_ins_move_with_what_they_introduce(self):
        record = load("lead_in")
        passages, _ = cp.build_passages(record, 24, words)
        self.assertGreater(len(passages), 1)
        texts = [p["text"] for p in passages]
        for lead_in, follower in (
            ("You could instead construct the check like so:", "```python"),
            ("## Why this change", "The old policy computed"),
            ("F.A.Q.", "- Will the old policy be removed?"),
        ):
            holder = [t for t in texts if lead_in in t]
            self.assertEqual(len(holder), 1, lead_in)
            self.assertIn(follower, holder[0], lead_in)
            self.assertFalse(holder[0].rstrip().endswith(lead_in), lead_in)

    def test_explanation_stays_with_its_proposal(self):
        record = load("context_needed")
        passages, _ = cp.build_passages(record, 50, words)
        self.assertEqual(len(passages), 1)
        tight, _ = cp.build_passages(record, 15, words)
        self.assertEqual(len(tight), 3)
        for p in tight:
            lines = p["text"].split("\n")
            self.assertEqual(len(lines), 2, p["text"])
            self.assertTrue(lines[0].startswith("We "), lines[0])
            self.assertTrue(lines[1].startswith(("However", "It ")), lines[1])


if __name__ == "__main__":
    unittest.main()
