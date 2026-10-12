"""Normalize GitHub Markdown into plain text for embedding (milestone CT-08).

Code is never changed. Fenced code blocks and inline code spans are protected
before any other rule runs and are restored verbatim afterwards, backticks
included. Underscore emphasis (``_x_``, ``__x__``) is left alone on purpose:
in a Python codebase ``__init__`` and ``my_var`` are far more common than
emphasis written with underscores.

What changes:
- CRLF line endings become LF; trailing spaces and runs of blank lines collapse.
- HTML comments, horizontal rules, and common HTML tags are removed.
  ``<br>`` becomes a newline and ``<img alt="x">`` becomes ``[image: x]``.
- Headings keep their ``#`` marker, so the chunker can keep a heading with the
  paragraph after it. ``**bold**``, ``*italic*``, and ``~~strike~~`` keep only
  their text.
- ``[text](url)`` becomes ``text (url)``; ``![alt](url)`` becomes ``[image: alt]``.
- ``*`` and ``+`` list bullets become ``-``. Blockquote markers (``>``) stay,
  because they show that the author is quoting someone else.
- HTML entities such as ``&amp;`` are decoded outside code.
"""

from __future__ import annotations

import html
import re
from typing import Callable

Replacement = str | Callable[[re.Match[str]], str]

_FENCE_RE = re.compile(
    r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[ \t]*$|\Z)", re.M | re.S
)
_CODE_SPAN_RE = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)", re.S)
_PLACEHOLDER_RE = re.compile(r"\x00(\d+)\x00")

_HTML_TAGS = (
    "details|summary|p|div|span|b|i|u|strong|em|kbd|sup|sub|a|ul|ol|li|h[1-6]"
    "|table|thead|tbody|tr|td|th|hr|center|font|pre|code|blockquote"
)


def _image(match: re.Match) -> str:
    alt = match.group(1).strip()
    return f"[image: {alt}]" if alt else "[image]"


def _link(match: re.Match) -> str:
    text, url = match.group(1).strip(), match.group(2)
    return url if text == url else f"{text} ({url})"


_RULES: list[tuple[re.Pattern[str], Replacement]] = [
    (re.compile(r"<!--.*?-->", re.S), ""),
    (re.compile(r"<br\s*/?>", re.I), "\n"),
    (re.compile(r"<img\b[^>]*\balt=[\"']([^\"']*)[\"'][^>]*>", re.I), _image),
    (re.compile(r"<img\b[^>]*>", re.I), "[image]"),
    (re.compile(rf"</?(?:{_HTML_TAGS})\b[^>]*>", re.I), ""),
    (re.compile(r"!\[([^\]]*)\]\([^)]*\)"), _image),
    (re.compile(r"\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)"), _link),
    (re.compile(r"<(https?://[^>\s]+)>"), r"\1"),
    (re.compile(r"^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$", re.M), r"\1 \2"),
    (re.compile(r"^[ \t]{0,3}(?:[-*_][ \t]*){3,}$", re.M), ""),
    (re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*"), r"\1"),
    (re.compile(r"(?<![\w*])\*(?=[^\s*])([^*\n]*?)(?<=\S)\*(?![\w*])"), r"\1"),
    (re.compile(r"~~(?=\S)(.+?)(?<=\S)~~"), r"\1"),
    (re.compile(r"^([ \t]*)[*+][ \t]+", re.M), r"\1- "),
]


def _protect_code(text: str) -> tuple[str, list[str]]:
    saved: list[str] = []

    def stash(match: re.Match) -> str:
        saved.append(match.group(0))
        return f"\x00{len(saved) - 1}\x00"

    text = _FENCE_RE.sub(stash, text)
    text = _CODE_SPAN_RE.sub(stash, text)
    return text, saved


def normalize_markdown(text: str | None) -> str:
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text, saved = _protect_code(text)
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+$", "", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = _PLACEHOLDER_RE.sub(lambda m: saved[int(m.group(1))], text)
    return text.strip()
