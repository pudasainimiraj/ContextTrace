import { decodeHTML } from "entities/decode";

/**
 * Port of pipeline/markdown_normalize.py: GitHub Markdown to plain text for embedding.
 *
 * Code is never changed. Fenced code blocks and inline code spans are protected before
 * any other rule runs and restored verbatim afterwards, backticks included. Underscore
 * emphasis is left alone so identifiers like __init__ and my_var survive.
 *
 * One deliberate deviation from the Python reference: a backtick fence's info string may
 * not contain a backtick (CommonMark), so a one-line ```code``` is an inline code span
 * rather than a fence that swallows the rest of the text.
 */
export const TEXT_KIND = "normalized_markdown" as const;

const HTML_TAGS =
  "details|summary|p|div|span|b|i|u|strong|em|kbd|sup|sub|a|ul|ol|li|h[1-6]" +
  "|table|thead|tbody|tr|td|th|hr|center|font|pre|code|blockquote";

type Replacer = (substring: string, ...groups: string[]) => string;

function image(_match: string, alt: string): string {
  const trimmed = alt.trim();
  return trimmed ? `[image: ${trimmed}]` : "[image]";
}

function link(_match: string, text: string, url: string): string {
  const label = text.trim();
  return label === url ? url : `${label} (${url})`;
}

const RULES: Array<[RegExp, string | Replacer]> = [
  [/<!--[\s\S]*?-->/g, ""],
  [/<br\s*\/?>/gi, "\n"],
  [/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, image],
  [/<img\b[^>]*>/gi, "[image]"],
  [new RegExp(`</?(?:${HTML_TAGS})\\b[^>]*>`, "gi"), ""],
  [/!\[([^\]]*)\]\([^)]*\)/g, image],
  [/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, link],
  [/<(https?:\/\/[^>\s]+)>/g, "$1"],
  [/^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, "$1 $2"],
  [/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, ""],
  [/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1"],
  // Python's \w is Unicode-aware; the guard keeps *args, a*b*c and **kwargs intact.
  [/(?<![\p{L}\p{N}_*])\*(?=[^\s*])([^*\n]*?)(?<=\S)\*(?![\p{L}\p{N}_*])/gu, "$1"],
  [/~~(?=\S)(.+?)(?<=\S)~~/g, "$1"],
  [/^([ \t]*)[*+][ \t]+/gm, "$1- "],
];

/** A fence opener line: optional indent, 3+ backticks (no backtick in the info string) or 3+ tildes. */
const FENCE_OPEN_RE = /^[ \t]*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const CODE_SPAN_RE = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g;
// Python wraps the stash index in null bytes; a private-use character is just as safe here.
const SENTINEL = "\uE000";
const PLACEHOLDER_RE = /\uE000(\d+)\uE000/g;

/**
 * Stashes fenced blocks like the Python _FENCE_RE: the block runs from the opener line to
 * the first line that is exactly the same marker (plus blanks), or to the end of the text.
 * An opener on the last line (no newline after it) is not a fence.
 */
function protectFences(text: string, saved: string[]): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN_RE.exec(lines[i]);
    if (!open || i === lines.length - 1) {
      out.push(lines[i]);
      continue;
    }
    const marker = open[1] ?? open[2];
    const closeRe = new RegExp(`^[ \\t]*${marker}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    const end = Math.min(j, lines.length - 1);
    saved.push(lines.slice(i, end + 1).join("\n"));
    out.push(`${SENTINEL}${saved.length - 1}${SENTINEL}`);
    i = end;
  }
  return out.join("\n");
}

function protectCode(text: string): [string, string[]] {
  const saved: string[] = [];
  const withoutFences = protectFences(text, saved);
  const protectedText = withoutFences.replace(CODE_SPAN_RE, (match) => {
    saved.push(match);
    return `${SENTINEL}${saved.length - 1}${SENTINEL}`;
  });
  return [protectedText, saved];
}

export function normalizeMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  let result = text.replace(/\r\n?/g, "\n");
  const [protectedText, saved] = protectCode(result);
  result = protectedText;
  for (const [pattern, replacement] of RULES) {
    result = typeof replacement === "string" ? result.replace(pattern, replacement) : result.replace(pattern, replacement);
  }
  result = decodeHTML(result);
  result = result.replace(/[ \t]+$/gm, "");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.replace(PLACEHOLDER_RE, (_match, index: string) => saved[Number(index)]);
  return result.trim();
}
