import { describe, expect, it } from "vitest";
import { countModelTokens, getTokenizer, MODEL_MAX_TOKENS } from "../../worker/src/etl/tokenizer.ts";

describe("bge-small-en-v1.5 tokenizer", () => {
  it("loads the vendored tokenizer under workerd and adds [CLS] and [SEP]", () => {
    expect(countModelTokens("")).toBe(2);
    expect(getTokenizer().encode("Hello World", { add_special_tokens: true }).ids).toEqual([101, 7592, 2088, 102]);
    expect(getTokenizer()).toBe(getTokenizer());
  });

  it("splits unknown identifiers into WordPiece pieces", () => {
    const { tokens } = getTokenizer().encode("AutoMaterializePolicy", { add_special_tokens: false });
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.some((t: string) => t.startsWith("##"))).toBe(true);
  });

  it("never truncates", () => {
    expect(countModelTokens("word ".repeat(600))).toBeGreaterThan(MODEL_MAX_TOKENS);
  });

  it("encodes a 4 KB comment quickly", async () => {
    const comment = "The scheduler drifted after the daylight saving change, so we moved to ticks. ".repeat(60);
    expect(comment.length).toBeGreaterThan(4000);
    const t0 = Date.now();
    let total = 0;
    for (let i = 0; i < 100; i++) total += countModelTokens(comment);
    // workerd's clock advances only across I/O, so cross one boundary before reading it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ms = Date.now() - t0;
    console.log(`100 encodes of a ${comment.length}-char comment (${total / 100} tokens each): ${ms} ms`);
    expect(ms).toBeLessThan(5000);
  });
});
