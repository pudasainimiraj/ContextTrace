import { describe, expect, it } from "vitest";
import { parseRepositoryInput } from "../../worker/src/api/github-url.ts";

const DAGSTER = { ok: true, owner: "dagster-io", name: "dagster" };

describe("parseRepositoryInput accepts", () => {
  it.each([
    "https://github.com/dagster-io/dagster",
    "https://github.com/dagster-io/dagster/",
    "https://github.com/dagster-io/dagster.git",
    "http://github.com/dagster-io/dagster",
    "https://www.github.com/dagster-io/dagster",
    "https://GitHub.com/dagster-io/dagster",
    "github.com/dagster-io/dagster",
    "www.github.com/dagster-io/dagster",
    "dagster-io/dagster",
    "dagster-io/dagster.git",
    "https://github.com/dagster-io/dagster/tree/master/python_modules",
    "https://github.com/dagster-io/dagster/pull/123",
    "https://github.com/dagster-io/dagster?tab=readme#top",
    "git@github.com:dagster-io/dagster.git",
    "  https://github.com/dagster-io/dagster  ",
  ])("%s", (input) => {
    expect(parseRepositoryInput(input)).toEqual(DAGSTER);
  });

  it("preserves case", () => {
    expect(parseRepositoryInput("Dagster-IO/Dagster")).toEqual({
      ok: true,
      owner: "Dagster-IO",
      name: "Dagster",
    });
  });
});

describe("parseRepositoryInput rejects", () => {
  it.each<[string, unknown]>([
    ["non-string", 42],
    ["empty", ""],
    ["whitespace", "   "],
    ["too long", "a/" + "b".repeat(600)],
    ["gitlab host", "https://gitlab.com/a/b"],
    ["gist host", "https://gist.github.com/a/b"],
    ["api host", "https://api.github.com/repos/a/b"],
    ["raw host", "https://raw.githubusercontent.com/a/b"],
    ["lookalike host", "https://github.com.evil.com/a/b"],
    ["host in path", "https://evil.com/github.com/a/b"],
    ["host in userinfo", "https://github.com@evil.com/a/b"],
    ["host only", "https://github.com"],
    ["host only with slash", "https://github.com/"],
    ["owner only", "https://github.com/dagster-io"],
    ["single segment", "foo"],
    ["leading hyphen owner", "-bad/name"],
    ["trailing hyphen owner", "bad-/name"],
    ["owner too long", "a".repeat(40) + "/name"],
    ["dot name", "a/."],
    ["dot-dot name", "a/.."],
    ["name too long", "a/" + "b".repeat(101)],
    ["space in name", "a/b c"],
    ["percent-encoded name", "a/b%20c"],
    ["javascript scheme", "javascript:alert(1)"],
    ["scheme typo", "https:/github.com/a/b"],
  ])("%s", (_label, input) => {
    const result = parseRepositoryInput(input);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeTruthy();
  });
});
