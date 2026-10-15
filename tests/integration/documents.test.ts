import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DocumentRecord, PassageRecord } from "../../shared/api.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { upsertSources } from "../../worker/src/etl/sources.ts";
import { repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme.
const REPO_ID = Date.now() * 100 + 45;
const db = createDb(env);
const DOC_ID = `github:${REPO_ID}:issue:1`;
const HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const document: Omit<DocumentRecord, "transformed_at"> = {
  document_id: DOC_ID,
  repository_id: REPO_ID,
  type: "issue",
  number: 1,
  title: "Replace the legacy API",
  transform_version: "test",
  sources_fetched_at: "2026-10-13T00:00:00Z",
};

function passage(index: number): Omit<PassageRecord, "updated_at"> {
  return {
    passage_id: `${DOC_ID}:body:${index}`,
    document_id: DOC_ID,
    repository_id: REPO_ID,
    source_type: "issue",
    source_github_id: 1001,
    chunk_index: index,
    chunk_count: 2,
    token_count: 12,
    tokenizer: "BAAI/bge-small-en-v1.5",
    locator: `Opening body (part ${index + 1} of 2)`,
    author: "ann",
    created_at: "2026-01-01T00:00:00Z",
    source_url: "https://github.com/o/r/issues/1",
    text: `part ${index}`,
    text_kind: "normalized_markdown",
    content_hash: HASH,
    transform_version: "test",
    index_state: "pending_index",
  };
}

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: REPO_ID, full_name: "alice/documents" }));
  await upsertSources(db, [
    {
      repository_id: REPO_ID,
      type: "issue",
      github_id: 1001,
      number: 1,
      node_id: null,
      title: "Replace the legacy API",
      author: "ann",
      body: "part 0\n\npart 1",
      state: "open",
      html_url: "https://github.com/o/r/issues/1",
      api_url: "https://api.github.com/repos/o/r/issues/1",
      path: null,
      line: null,
      in_reply_to_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null,
      fetched_by_job: null,
    },
  ]);
});
afterAll(async () => {
  await db.from("repositories").delete().eq("id", REPO_ID);
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("documents and passages schema", () => {
  it("stores a document with its passages in the shared record shape", async () => {
    expect((await db.from("documents").insert(document)).error).toBeNull();
    expect((await db.from("passages").insert([passage(0), passage(1)])).error).toBeNull();

    const { data: doc } = await db.from("documents").select("*").eq("document_id", DOC_ID).single();
    expect(doc).toMatchObject({ ...document, sources_fetched_at: expect.any(String) });
    expect(Date.parse((doc as DocumentRecord).transformed_at)).toBeGreaterThan(0);

    const { data: rows } = await db.from("passages").select("*").eq("document_id", DOC_ID).order("chunk_index");
    expect(rows).toHaveLength(2);
    expect(rows?.[1]).toMatchObject({ passage_id: `${DOC_ID}:body:1`, chunk_index: 1, text: "part 1", content_hash: HASH });
  });

  it("rejects a passage without its source row and a document of an unknown type", async () => {
    const orphan = await db.from("passages").insert({ ...passage(2), passage_id: `${DOC_ID}:body:2`, source_github_id: 999, chunk_count: 3 });
    expect(orphan.error?.code).toBe("23503");
    const bad = await db.from("documents").insert({ ...document, document_id: `github:${REPO_ID}:discussion:2`, number: 2, type: "discussion" });
    expect(bad.error?.code).toBe("23514");
  });

  it("removes documents and passages when the repository is deleted", async () => {
    const sibling = REPO_ID + 1;
    await upsertRepository(db, repoFixture({ id: sibling, full_name: "alice/documents-sibling" }));
    await upsertSources(db, [{ repository_id: sibling, type: "issue", github_id: 2001, number: 1, node_id: null, title: "t", author: null, body: "b", state: null, html_url: "u", api_url: "a", path: null, line: null, in_reply_to_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: null, fetched_by_job: null }]);
    const sdoc = `github:${sibling}:issue:1`;
    expect((await db.from("documents").insert({ ...document, document_id: sdoc, repository_id: sibling })).error).toBeNull();
    expect((await db.from("passages").insert({ ...passage(0), passage_id: `${sdoc}:body:0`, document_id: sdoc, repository_id: sibling, source_github_id: 2001, chunk_count: 1 })).error).toBeNull();

    await db.from("repositories").delete().eq("id", sibling);
    const { count } = await db.from("passages").select("*", { count: "exact", head: true }).eq("repository_id", sibling);
    expect(count).toBe(0);
  });
});
