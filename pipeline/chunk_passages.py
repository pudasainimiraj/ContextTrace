#!/usr/bin/env python3
"""Turn fetched GitHub issue JSON into embedding-ready passages (milestone CT-09).

Each passage comes from exactly one source unit: the opening body or one
comment. A passage never mixes speakers. A unit that exceeds the token limit
is split at paragraph, line, sentence, and word boundaries, in that order.
A heading, a short label line, or a lead-in that ends with a colon moves to
the next passage together with the paragraph it introduces, when the two fit.
A fenced code block counts as one paragraph; an oversized block is split
into smaller blocks that each keep the opening and closing fence. Every
passage carries the document title, the author, the date, and a link to its
source unit.

Usage:
    python chunk_passages.py data/github/dagster-io__dagster/issue_4194.json
    python chunk_passages.py data/github/dagster-io__dagster/*.json --max-tokens 512

Tokens are counted with tiktoken (cl100k_base) when it is installed, and
estimated as one token per four characters otherwise.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from fetch_github import write_json_atomic
from markdown_normalize import normalize_markdown

DEFAULT_MAX_TOKENS = 512
TOKENIZER_NAME = "cl100k_base"

log = logging.getLogger("chunk_passages")

TokenCounter = Callable[[str], int]


def make_token_counter() -> tuple[str, TokenCounter]:
    """Return ``(tokenizer_name, count_tokens)``."""
    try:
        import tiktoken

        encoding = tiktoken.get_encoding(TOKENIZER_NAME)
    except Exception as err:  # ImportError, or the encoding file cannot be downloaded
        log.warning("tiktoken unavailable (%s); estimating one token per four characters", err)
        return "chars/4", lambda text: -(-len(text) // 4)
    return TOKENIZER_NAME, lambda text: len(encoding.encode(text, disallowed_special=()))


# --- splitting ---------------------------------------------------------------

_FENCE_LINE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})")
_HEADING_RE = re.compile(r"^[ \t]*#{1,6} ")
_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")


def split_paragraphs(text: str) -> list[str]:
    """Split on blank lines, keeping each fenced code block whole."""
    paragraphs: list[str] = []
    current: list[str] = []
    fence: str | None = None
    for line in text.split("\n"):
        if fence is not None:
            current.append(line)
            if line.strip().startswith(fence):
                fence = None
            continue
        if not line.strip():
            if current:
                paragraphs.append("\n".join(current))
                current = []
            continue
        match = _FENCE_LINE_RE.match(line)
        if match:
            fence = match.group(1)
        current.append(line)
    if current:
        paragraphs.append("\n".join(current))
    return paragraphs


def _is_lead_in(paragraph: str) -> bool:
    """A heading, a short label line, or a line ending with a colon introduces what follows."""
    last_line = paragraph.rsplit("\n", 1)[-1].strip()
    if _HEADING_RE.match(last_line) or last_line.endswith(":"):
        return True
    return "\n" not in paragraph and len(paragraph.split()) <= 4


def _is_fence(paragraph: str) -> bool:
    lines = paragraph.split("\n")
    return len(lines) >= 2 and bool(_FENCE_LINE_RE.match(lines[0])) and bool(_FENCE_LINE_RE.match(lines[-1]))


def _split_fence(paragraph: str, max_tokens: int, count_tokens: TokenCounter) -> list[str]:
    """Split an oversized fenced block into smaller blocks that each keep both fence lines."""
    lines = paragraph.split("\n")
    opening, closing, body = lines[0], lines[-1], lines[1:-1]
    chunks: list[str] = []
    current: list[str] = []
    for line in body:
        if count_tokens("\n".join([opening, *current, line, closing])) <= max_tokens:
            current.append(line)
            continue
        if current:
            chunks.append("\n".join([opening, *current, closing]))
            current = []
        if count_tokens("\n".join([opening, line, closing])) <= max_tokens:
            current.append(line)
        else:
            chunks.extend(_split(line, max_tokens, count_tokens, 2))
    if current:
        chunks.append("\n".join([opening, *current, closing]))
    return chunks


_LEVELS: list[tuple[Callable[[str], list[str]], str]] = [
    (split_paragraphs, "\n\n"),
    (lambda text: text.split("\n"), "\n"),
    (_SENTENCE_END_RE.split, " "),
    (lambda text: text.split(" "), " "),
]


def split_text(text: str, max_tokens: int, count_tokens: TokenCounter) -> list[str]:
    """Split ``text`` into chunks of at most ``max_tokens``, preferring large boundaries."""
    chunks = (chunk.strip() for chunk in _split(text, max_tokens, count_tokens, 0))
    return [chunk for chunk in chunks if chunk]


def _split(text: str, max_tokens: int, count_tokens: TokenCounter, level: int) -> list[str]:
    if count_tokens(text) <= max_tokens:
        return [text]
    if level == len(_LEVELS):
        return _hard_split(text, max_tokens, count_tokens)
    splitter, separator = _LEVELS[level]
    chunks: list[str] = []
    current: list[str] = []
    for part in splitter(text):
        if count_tokens(separator.join(current + [part])) <= max_tokens:
            current.append(part)
            continue
        # The chunk is full. Trailing lead-ins move on with the paragraph they introduce.
        carried: list[str] = []
        if level == 0:
            while (
                len(current) > 1
                and _is_lead_in(current[-1])
                and count_tokens(separator.join([current[-1], *carried, part])) <= max_tokens
            ):
                carried.insert(0, current.pop())
        if current:
            chunks.append(separator.join(current))
        current = carried
        if count_tokens(separator.join(current + [part])) <= max_tokens:
            current.append(part)
        elif level == 0 and _is_fence(part):
            chunks.extend(_split_fence(part, max_tokens, count_tokens))
        else:
            chunks.extend(_split(part, max_tokens, count_tokens, level + 1))
    if current:
        chunks.append(separator.join(current))
    return chunks


def _hard_split(text: str, max_tokens: int, count_tokens: TokenCounter) -> list[str]:
    """Last resort for a single token-dense run with no separators, such as a long URL."""
    size = max(1, max_tokens // 2)
    while True:
        pieces = [text[i : i + size] for i in range(0, len(text), size)]
        if size == 1 or all(count_tokens(piece) <= max_tokens for piece in pieces):
            return pieces
        size //= 2


# --- passages ----------------------------------------------------------------


def build_passages(record: dict, max_tokens: int, count_tokens: TokenCounter) -> tuple[list[dict], int]:
    """Return ``(passages, skipped_empty_units)`` for one fetched issue record."""
    opening = record[record["type"]]
    document_id = record["document_id"]
    comments = record["comments"]
    position = {comment["id"]: index for index, comment in enumerate(comments, start=1)}
    units = [
        {
            "source_unit": "opening_body",
            "comment_id": None,
            "author": opening["author"],
            "created_at": opening["created_at"],
            "source_url": opening["html_url"],
            "locator": "Opening body",
            "body": opening["body"],
        }
    ]
    for index, comment in enumerate(comments, start=1):
        locator = f"Comment {index} of {len(comments)}"
        parent = comment.get("reply_to")
        if parent is not None:
            locator += f", reply to comment {position.get(parent, '?')}"
        units.append(
            {
                "source_unit": "comment",
                "comment_id": comment["id"],
                "author": comment["author"],
                "created_at": comment["created_at"],
                "source_url": comment["html_url"],
                "locator": locator,
                "body": comment["body"],
            }
        )

    passages: list[dict] = []
    skipped = 0
    for unit in units:
        text = normalize_markdown(unit["body"])
        if not text:
            skipped += 1
            continue
        chunks = split_text(text, max_tokens, count_tokens)
        if unit["comment_id"] is None:
            id_prefix = f"{document_id}:body"
        else:
            id_prefix = f"{document_id}:comment:{unit['comment_id']}"
        for index, chunk in enumerate(chunks):
            locator = unit["locator"]
            if len(chunks) > 1:
                locator += f" (part {index + 1} of {len(chunks)})"
            passages.append(
                {
                    "passage_id": f"{id_prefix}:{index}",
                    "document_id": document_id,
                    "title": opening["title"],
                    "source_url": unit["source_url"],
                    "source_unit": unit["source_unit"],
                    "comment_id": unit["comment_id"],
                    "author": unit["author"],
                    "created_at": unit["created_at"],
                    "locator": locator,
                    "chunk_index": index,
                    "chunk_count": len(chunks),
                    "token_count": count_tokens(chunk),
                    "text": chunk,
                    "text_kind": "normalized_markdown",
                }
            )
    return passages, skipped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Turn fetched GitHub issue JSON into embedding-ready passages."
    )
    parser.add_argument("inputs", nargs="+", type=Path, help="issue JSON files from fetch_github.py")
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS, help="limit per passage")
    parser.add_argument("--out-dir", type=Path, default=Path("data/passages"))
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr
    )

    tokenizer, count_tokens = make_token_counter()
    for path in args.inputs:
        with open(path, encoding="utf-8") as fh:
            record = json.load(fh)
        passages, skipped = build_passages(record, args.max_tokens, count_tokens)
        output = {
            "schema_version": "1.0",
            "document_id": record["document_id"],
            "repository": record["repository"],
            "type": record["type"],
            "number": record["number"],
            "title": record[record["type"]]["title"],
            "source_url": record["source_url"],
            "fetched_at": record["fetched_at"],
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tokenizer": tokenizer,
            "max_tokens": args.max_tokens,
            "passage_count": len(passages),
            "skipped_empty_units": skipped,
            "passages": passages,
        }
        out_path = args.out_dir / record["repository"].replace("/", "__") / path.name
        write_json_atomic(out_path, output)
        log.info(
            "Saved %s (%d passages from %d units, %d empty units skipped)",
            out_path, len(passages), 1 + len(record["comments"]), skipped,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
