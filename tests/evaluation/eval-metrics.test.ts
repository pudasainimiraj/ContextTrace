import { describe, expect, it } from "vitest";
import { hitAtK, mean, reciprocalRankAtK, recallAtK, round, threadHitAtK, threadOf, unitOf, unsupportedOutcome } from "./metrics.ts";

const A = "github:1:issue:5:body";
const B = "github:1:issue:5:issue_comment:77";
const C = "github:1:pull_request:9:review_comment:88";

describe("evaluation metrics", () => {
  it("credit a unit whatever chunk of it came back, once", () => {
    expect(unitOf(`${A}:0`)).toBe(A);
    expect(unitOf(`${B}:3`)).toBe(B);
    expect(recallAtK([`${A}:0`, `${B}:0`], [`${A}:2`, `${A}:0`, `${C}:0`], 3)).toBe(0.5);
    expect(recallAtK([`${A}:0`, `${B}:0`], [`${A}:1`, `${C}:0`, `${B}:4`], 3)).toBe(1);
    expect(recallAtK([`${A}:0`, `${B}:0`], [`${C}:0`, `${C}:1`, `${C}:2`, `${A}:0`], 3)).toBe(0);
    expect(recallAtK([], [`${A}:0`], 3)).toBe(0);
  });

  it("hit and reciprocal rank look only inside the cut-off", () => {
    expect(hitAtK([`${A}:0`], [`${C}:0`, `${C}:1`, `${A}:0`], 3)).toBe(1);
    expect(hitAtK([`${A}:0`], [`${C}:0`, `${C}:1`, `${C}:2`, `${A}:0`], 3)).toBe(0);
    expect(reciprocalRankAtK([`${A}:0`], [`${C}:0`, `${A}:0`], 5)).toBe(0.5);
    expect(reciprocalRankAtK([`${A}:0`, `${B}:0`], [`${B}:1`], 5)).toBe(1);
    expect(reciprocalRankAtK([`${A}:0`], [], 5)).toBe(0);
    expect(reciprocalRankAtK([`${A}:0`], [`${C}:0`, `${C}:1`, `${C}:2`, `${C}:3`, `${C}:4`, `${A}:0`], 5)).toBe(0);
  });

  it("credit the thread as a looser, secondary view", () => {
    expect(threadOf(`${B}:3`)).toBe("github:1:issue:5");
    expect(threadHitAtK([`${B}:0`], [`${C}:0`, `${A}:2`], 3)).toBe(1); // A and B share thread 5
    expect(threadHitAtK([`${B}:0`], [`${C}:0`], 3)).toBe(0);
  });

  it("judge an unsupported question by the auto response", () => {
    expect(unsupportedOutcome({ mode: "none", confidence: "none" })).toBe("abstained");
    expect(unsupportedOutcome({ mode: "keyword", confidence: "low" })).toBe("hedged");
    expect(unsupportedOutcome({ mode: "semantic", confidence: "low" })).toBe("hedged");
    expect(unsupportedOutcome({ mode: "semantic", confidence: "high" })).toBe("false_positive");
  });

  it("average and round", () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 0, 0.5])).toBe(0.5);
    expect(round(2 / 3)).toBe(0.667);
  });
});
