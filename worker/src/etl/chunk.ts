/**
 * Port of the splitting half of pipeline/chunk_passages.py.
 *
 * A unit that exceeds the token budget is split at paragraph, line, sentence and word
 * boundaries, in that order, then by characters as a last resort. Chunks are packed
 * greedily and measured on the joined text, so separators count. A heading, a short label
 * line or a line ending with a colon moves to the next chunk together with the paragraph it
 * introduces when the two fit. A fenced code block is one paragraph; an oversized block is
 * split into smaller blocks that each keep the opening and closing fence.
 */
export type TokenCounter = (text: string) => number;

/** Model tokens per passage, [CLS] and [SEP] included: one to three paragraphs of prose. */
export const MAX_PASSAGE_TOKENS = 256;

const FENCE_LINE_RE = /^[ \t]*(`{3,}|~{3,})/;
/** A fence opener: a backtick fence's info string may not contain a backtick (CommonMark). */
const FENCE_OPEN_RE = /^[ \t]*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const HEADING_RE = /^[ \t]*#{1,6} /;
const SENTENCE_END_RE = /(?<=[.!?])\s+/;

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Splits on blank lines, keeping each fenced code block whole. */
export function splitParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    if (fence !== null) {
      current.push(line);
      // Python parity: any line that starts with the marker closes the fence.
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (!line.trim()) {
      if (current.length) {
        paragraphs.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) fence = open[1] ?? open[2];
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join("\n"));
  return paragraphs;
}

/** A heading, a short label line, or a line ending with a colon introduces what follows. */
export function isLeadIn(paragraph: string): boolean {
  const lastLine = paragraph.slice(paragraph.lastIndexOf("\n") + 1).trim();
  if (HEADING_RE.test(lastLine) || lastLine.endsWith(":")) return true;
  return !paragraph.includes("\n") && words(paragraph) <= 4;
}

export function isFence(paragraph: string): boolean {
  const lines = paragraph.split("\n");
  return lines.length >= 2 && FENCE_LINE_RE.test(lines[0]) && FENCE_LINE_RE.test(lines[lines.length - 1]);
}

/** Splits an oversized fenced block into smaller blocks that each keep both fence lines. */
function splitFence(paragraph: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const lines = paragraph.split("\n");
  const opening = lines[0];
  const closing = lines[lines.length - 1];
  const body = lines.slice(1, -1);
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of body) {
    if (countTokens([opening, ...current, line, closing].join("\n")) <= maxTokens) {
      current.push(line);
      continue;
    }
    if (current.length) {
      chunks.push([opening, ...current, closing].join("\n"));
      current = [];
    }
    if (countTokens([opening, line, closing].join("\n")) <= maxTokens) {
      current.push(line);
    } else {
      chunks.push(...split(line, maxTokens, countTokens, 2));
    }
  }
  if (current.length) chunks.push([opening, ...current, closing].join("\n"));
  return chunks;
}

const LEVELS: Array<[(text: string) => string[], string]> = [
  [splitParagraphs, "\n\n"],
  [(text) => text.split("\n"), "\n"],
  [(text) => text.split(SENTENCE_END_RE), " "],
  [(text) => text.split(" "), " "],
];

/** Splits `text` into chunks of at most `maxTokens`, preferring large boundaries. */
export function splitText(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
  return split(text, maxTokens, countTokens, 0)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function split(text: string, maxTokens: number, countTokens: TokenCounter, level: number): string[] {
  if (countTokens(text) <= maxTokens) return [text];
  if (level === LEVELS.length) return hardSplit(text, maxTokens, countTokens);
  const [splitter, separator] = LEVELS[level];
  const chunks: string[] = [];
  let current: string[] = [];
  for (const part of splitter(text)) {
    if (countTokens([...current, part].join(separator)) <= maxTokens) {
      current.push(part);
      continue;
    }
    // The chunk is full. Trailing lead-ins move on with the paragraph they introduce.
    const carried: string[] = [];
    if (level === 0) {
      while (
        current.length > 1 &&
        isLeadIn(current[current.length - 1]) &&
        countTokens([current[current.length - 1], ...carried, part].join(separator)) <= maxTokens
      ) {
        carried.unshift(current.pop()!);
      }
    }
    if (current.length) chunks.push(current.join(separator));
    current = carried;
    if (countTokens([...current, part].join(separator)) <= maxTokens) {
      current.push(part);
    } else if (level === 0 && isFence(part)) {
      chunks.push(...splitFence(part, maxTokens, countTokens));
    } else {
      chunks.push(...split(part, maxTokens, countTokens, level + 1));
    }
  }
  if (current.length) chunks.push(current.join(separator));
  return chunks;
}

/** Last resort for a single token-dense run with no separators, such as a long URL. */
function hardSplit(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
  const chars = Array.from(text); // code points, like Python's len() and slicing
  let size = Math.max(1, Math.floor(maxTokens / 2));
  for (;;) {
    const pieces: string[] = [];
    for (let i = 0; i < chars.length; i += size) pieces.push(chars.slice(i, i + size).join(""));
    if (size === 1 || pieces.every((piece) => countTokens(piece) <= maxTokens)) return pieces;
    size = Math.floor(size / 2);
  }
}
