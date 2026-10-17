import { describe, expect, it } from "vitest";
import { normalizeMarkdown } from "../../worker/src/etl/normalize.ts";
import { fixtureDocument, loadFixture } from "../fixtures/index.ts";

const GOLDEN = import.meta.glob("../fixtures/github_markup.*", { eager: true, query: "?raw", import: "default" }) as Record<
  string,
  string
>;

describe("normalizeMarkdown", () => {
  it("keeps code names in inline code and identifiers", () => {
    const out = normalizeMarkdown("Use `my_var_name` and `**kwargs` with __init__, snake_case_name and *args here.");
    for (const name of ["`my_var_name`", "`**kwargs`", "__init__", "snake_case_name", "*args"]) {
      expect(out).toContain(name);
    }
  });

  it("keeps a fenced block verbatim and converts CRLF to LF", () => {
    const out = normalizeMarkdown("Run:\r\n\r\n```bash\r\npip install x[sqlite]\r\n**not bold** <!-- kept --> &amp;\r\n```\r\n");
    expect(out).toContain("```bash\npip install x[sqlite]\n**not bold** <!-- kept --> &amp;\n```");
  });

  it("removes markup but keeps the text", () => {
    const out = normalizeMarkdown(
      "## Title\n\n<!-- template -->\n**bold** and *it* and ~~gone~~\n\n" +
        "[docs](https://d.io) ![shot](x.png)\n\n<details><summary>Logs</summary>\n" +
        "line<br>next\n</details>\n\n* bullet\n\n---\n\n\n\nend &amp; done  \n",
    );
    for (const gone of ["<!--", "**", "~~", "<details>", "<br>", "---", "\n\n\n", "&amp;"]) {
      expect(out).not.toContain(gone);
    }
    for (const kept of ["## Title", "bold and it and gone", "docs (https://d.io)", "[image: shot]", "Logs\nline\nnext", "- bullet", "end & done"]) {
      expect(out).toContain(kept);
    }
    expect(out).toBe(out.trim());
  });

  it("keeps blockquotes and mentions", () => {
    expect(normalizeMarkdown("> @alice said #12 is done\n\nAgreed @bob")).toBe("> @alice said #12 is done\n\nAgreed @bob");
  });

  it("returns an empty string for null, undefined and whitespace", () => {
    expect(normalizeMarkdown(null)).toBe("");
    expect(normalizeMarkdown(undefined)).toBe("");
    expect(normalizeMarkdown("  \r\n ")).toBe("");
  });

  it("decodes HTML entities outside code only, including legacy ones without a semicolon", () => {
    expect(normalizeMarkdown("a &amp b &copy; c &#x27;d&#x27; `&amp;` and\n\n```\n&lt;\n```")).toBe(
      "a & b © c 'd' `&amp;` and\n\n```\n&lt;\n```",
    );
  });

  it("guards italics against identifiers, globs and Unicode letters", () => {
    expect(normalizeMarkdown("*args and a*b*c and é*x*é stay; *it* goes")).toBe("*args and a*b*c and é*x*é stay; it goes");
  });

  it("does not treat a one-line ```code``` as a fence (deviation from the Python reference)", () => {
    const out = normalizeMarkdown("As the docs note:\n\n```Use of pkg_resources is discouraged.```\n\n**Please** switch.");
    expect(out).toBe("As the docs note:\n\n```Use of pkg_resources is discouraged.```\n\nPlease switch.");
  });

  it("closes a fence only on a line that is exactly the same marker", () => {
    const out = normalizeMarkdown("````md\n```\n**inner**\n```\n````\n\n**outer**");
    expect(out).toBe("````md\n```\n**inner**\n```\n````\n\nouter");
  });

  it("keeps an unclosed fence to the end of the text", () => {
    expect(normalizeMarkdown("before **b**\n\n```py\nx = **1**\nmore")).toBe("before b\n\n```py\nx = **1**\nmore");
  });

  it("preserves AutoMaterializePolicy in every form of the code_name fixture", () => {
    const doc = fixtureDocument(loadFixture("code_name"));
    const joined = [doc.opening, ...doc.comments].map((u) => normalizeMarkdown(u.body)).join("\n");
    expect(joined.split("AutoMaterializePolicy").length - 1).toBe(5);
    expect(joined).toContain("`AutoMaterializePolicy`");
    expect(joined).toContain("AutoMaterializePolicy.eager()");
    expect(joined).toContain("auto_materialize_policy=AutoMaterializePolicy.lazy()");
    expect(joined).not.toContain("**");
  });

  it("matches the golden output for a GitHub-flavoured comment", () => {
    const input = GOLDEN["../fixtures/github_markup.md"];
    const expected = GOLDEN["../fixtures/github_markup.expected.txt"];
    expect(normalizeMarkdown(input)).toBe(expected.replace(/\n$/, ""));
  });
});
