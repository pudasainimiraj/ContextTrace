"""Tests for markdown_normalize (CT-08) and chunk_passages (CT-09). Run from the repo root:

    python -m unittest discover tests
"""

import unittest

import chunk_passages as cp
from markdown_normalize import normalize_markdown


def words(text):
    return len(text.split())


class NormalizeTests(unittest.TestCase):
    def test_code_names_survive(self):
        src = "Use `my_var_name` and `**kwargs` with __init__, snake_case_name and *args here."
        out = normalize_markdown(src)
        for name in ("`my_var_name`", "`**kwargs`", "__init__", "snake_case_name", "*args"):
            self.assertIn(name, out)

    def test_fenced_block_is_verbatim(self):
        src = "Run:\r\n\r\n```bash\r\npip install x[sqlite]\r\n**not bold** <!-- kept --> &amp;\r\n```\r\n"
        out = normalize_markdown(src)
        self.assertIn("```bash\npip install x[sqlite]\n**not bold** <!-- kept --> &amp;\n```", out)

    def test_markup_is_removed_but_text_is_kept(self):
        src = (
            "## Title\n\n<!-- template -->\n**bold** and *it* and ~~gone~~\n\n"
            "[docs](https://d.io) ![shot](x.png)\n\n<details><summary>Logs</summary>\n"
            "line<br>next\n</details>\n\n* bullet\n\n---\n\n\n\nend &amp; done  \n"
        )
        out = normalize_markdown(src)
        for gone in ("<!--", "**", "~~", "<details>", "<br>", "---", "\n\n\n", "&amp;"):
            self.assertNotIn(gone, out)
        for kept in ("## Title", "bold and it and gone", "docs (https://d.io)", "[image: shot]",
                     "Logs\nline\nnext", "- bullet", "end & done"):
            self.assertIn(kept, out)
        self.assertEqual(out, out.strip())

    def test_blockquote_and_mentions_are_kept(self):
        out = normalize_markdown("> @alice said #12 is done\n\nAgreed @bob")
        self.assertEqual(out, "> @alice said #12 is done\n\nAgreed @bob")

    def test_empty_input(self):
        self.assertEqual(normalize_markdown(None), "")
        self.assertEqual(normalize_markdown("  \r\n "), "")


class SplitTests(unittest.TestCase):
    def test_short_text_is_one_chunk(self):
        self.assertEqual(cp.split_text("a b c", 10, words), ["a b c"])

    def test_paragraphs_are_packed_up_to_the_limit(self):
        p = ["p1 a b c d", "p2 a b c d", "p3 a b c d", "p4 a b c d"]
        chunks = cp.split_text("\n\n".join(p), 10, words)
        self.assertEqual(chunks, [p[0] + "\n\n" + p[1], p[2] + "\n\n" + p[3]])

    def test_fenced_block_stays_whole_when_it_fits(self):
        text = "intro words here\n\n```\na\n\nb\n```\n\nmore words"
        chunks = cp.split_text(text, 4, words)
        self.assertIn("```\na\n\nb\n```", chunks)

    def test_long_paragraph_splits_on_sentences(self):
        chunks = cp.split_text("one two three. four five six. seven eight nine.", 3, words)
        self.assertEqual(chunks, ["one two three.", "four five six.", "seven eight nine."])

    def test_giant_token_run_is_hard_split(self):
        text = "x" * 50
        chunks = cp.split_text(text, 4, len)
        self.assertTrue(all(len(c) <= 4 for c in chunks))
        self.assertEqual("".join(chunks), text)

    def test_no_words_are_lost(self):
        text = "\n\n".join(" ".join(f"w{i}_{j}" for j in range(7)) for i in range(5))
        chunks = cp.split_text(text, 5, words)
        self.assertEqual(" ".join(chunks).split(), text.split())
        self.assertTrue(all(words(c) <= 5 for c in chunks))


class PassageTests(unittest.TestCase):
    RECORD = {
        "type": "issue",
        "document_id": "github:o/r:issue:1",
        "issue": {"title": "T", "author": "ann", "created_at": "d1", "html_url": "u",
                  "body": "p1 p2 p3 p4 p5 p6"},
        "comments": [
            {"id": 7, "author": "bob", "created_at": "d2", "html_url": "u#7", "body": "c1 c2 c3 c4 c5"},
            {"id": 8, "author": "cy", "created_at": "d3", "html_url": "u#8", "body": "<!-- x -->"},
            {"id": 9, "author": "dee", "created_at": "d4", "html_url": "u#9", "body": "short"},
        ],
    }

    def test_passages_never_mix_units(self):
        passages, skipped = cp.build_passages(self.RECORD, 4, words)
        self.assertEqual(skipped, 1)
        ids = [p["passage_id"] for p in passages]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(p["token_count"] <= 4 and p["title"] == "T" for p in passages))

        body = [p for p in passages if p["source_unit"] == "opening_body"]
        self.assertEqual([p["locator"] for p in body],
                         ["Opening body (part 1 of 2)", "Opening body (part 2 of 2)"])
        self.assertTrue(all(p["author"] == "ann" and p["source_url"] == "u" for p in body))
        self.assertEqual([p["passage_id"] for p in body],
                         ["github:o/r:issue:1:body:0", "github:o/r:issue:1:body:1"])

        c7 = [p for p in passages if p["comment_id"] == 7]
        self.assertEqual([p["locator"] for p in c7],
                         ["Comment 1 of 3 (part 1 of 2)", "Comment 1 of 3 (part 2 of 2)"])
        self.assertTrue(all(p["author"] == "bob" and p["source_url"] == "u#7" for p in c7))
        self.assertEqual(c7[0]["passage_id"], "github:o/r:issue:1:comment:7:0")

        c9 = [p for p in passages if p["comment_id"] == 9]
        self.assertEqual(len(c9), 1)
        self.assertEqual(c9[0]["locator"], "Comment 3 of 3")
        self.assertEqual(c9[0]["chunk_count"], 1)


if __name__ == "__main__":
    unittest.main()
