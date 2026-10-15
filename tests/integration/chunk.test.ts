import { describe, expect, it } from "vitest";
import { splitParagraphs, splitText } from "../../worker/src/etl/chunk.ts";
import { words } from "../fixtures/index.ts";

const codePoints = (text: string) => Array.from(text).length;

describe("splitText", () => {
  it("keeps short text as one chunk", () => {
    expect(splitText("a b c", 10, words)).toEqual(["a b c"]);
  });

  it("packs paragraphs up to the limit", () => {
    const p = ["p1 a b c d", "p2 a b c d", "p3 a b c d", "p4 a b c d"];
    expect(splitText(p.join("\n\n"), 10, words)).toEqual([`${p[0]}\n\n${p[1]}`, `${p[2]}\n\n${p[3]}`]);
  });

  it("keeps a fenced block with a blank line inside whole", () => {
    expect(splitText("intro words here\n\n```\na\n\nb\n```\n\nmore words", 4, words)).toContain("```\na\n\nb\n```");
  });

  it("splits a long paragraph on sentences", () => {
    expect(splitText("one two three. four five six. seven eight nine.", 3, words)).toEqual([
      "one two three.",
      "four five six.",
      "seven eight nine.",
    ]);
  });

  it("hard-splits a giant token run", () => {
    const text = "x".repeat(50);
    const chunks = splitText(text, 4, codePoints);
    expect(chunks.every((c) => c.length <= 4)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("loses no words", () => {
    const text = Array.from({ length: 5 }, (_, i) => Array.from({ length: 7 }, (_, j) => `w${i}_${j}`).join(" ")).join("\n\n");
    const chunks = splitText(text, 5, words);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
    expect(chunks.every((c) => words(c) <= 5)).toBe(true);
  });

  it("hard-splits by code points so surrogate pairs survive", () => {
    const text = "😀".repeat(50);
    const chunks = splitText(text, 4, codePoints);
    const loneSurrogate = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]($|[^\uDC00-\uDFFF])/;
    expect(chunks.every((c) => codePoints(c) <= 4 && !loneSurrogate.test(c))).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("splitParagraphs", () => {
  it("closes a fence on any line that starts with the marker (Python prefix check)", () => {
    expect(splitParagraphs("```py\nx = 1\n\ny = 2\n```extra\n\nafter")).toEqual(["```py\nx = 1\n\ny = 2\n```extra", "after"]);
  });

  it("does not open a fence on a one-line ```code``` span", () => {
    expect(splitParagraphs("note:\n\n```one liner```\n\nnext paragraph")).toEqual(["note:", "```one liner```", "next paragraph"]);
  });

  it("keeps a tilde fence whole", () => {
    expect(splitParagraphs("~~~\na\n\nb\n~~~\n\nc")).toEqual(["~~~\na\n\nb\n~~~", "c"]);
  });
});
