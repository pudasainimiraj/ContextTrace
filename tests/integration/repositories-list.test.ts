import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepositoryListResponse, RepositoryRecord, RepositorySummary, ServiceStatus } from "../../shared/api.ts";
import { MAX_REPOSITORIES } from "../../worker/src/api/admission.ts";
import { bySummaryOrder } from "../../worker/src/api/coverage.ts";
import { createDb, upsertRepository } from "../../worker/src/api/repositories.ts";
import { createJob } from "../../worker/src/queue/jobs.ts";
import { insertPassages, repoFixture } from "./helpers.ts";

// Runs against the real Supabase project; see jobs.test.ts for the id scheme. The tens digit 6 is this file's.
const ID_IDLE = Date.now() * 100 + 60;
const ID_BUSY = ID_IDLE + 1;
const ID_UNDERSCORE = ID_IDLE + 2;
const db = createDb(env);
const get = (path: string) => exports.default.fetch(`http://localhost${path}`);

beforeAll(async () => {
  await upsertRepository(db, repoFixture({ id: ID_IDLE, full_name: "alice/list-idle" }));
  await upsertRepository(db, repoFixture({ id: ID_BUSY, full_name: "alice/list-busy" }));
  await upsertRepository(db, repoFixture({ id: ID_UNDERSCORE, full_name: "alice/list_idle" }));
  await insertPassages(db, ID_BUSY, [{ text: "A passage waiting for its vector." }]);
  await createJob(db, ID_BUSY, "fetch_issues"); // queued and never sent, so it stays active for the test
});
afterAll(async () => {
  await db.from("repositories").delete().in("id", [ID_IDLE, ID_BUSY, ID_UNDERSCORE]);
});

describe("bySummaryOrder", () => {
  const summary = (over: Partial<RepositorySummary>): RepositorySummary => ({
    id: 1,
    full_name: "o/r",
    status: "searchable",
    status_changed_at: "2026-01-01T00:00:00+00:00",
    last_error: null,
    passages: 0,
    embedded: 0,
    pending: 0,
    last_successful_sync_at: null,
    active_jobs: [],
    ...over,
  });
  it("puts working repositories first, unreachable ones last, and the rest newest sync first", () => {
    const working = summary({ id: 1, active_jobs: [{ kind: "fetch_issues", state: "queued", error_code: null, next_attempt_at: null, started_at: null, attempt: 0, lease_until: null }] });
    const recent = summary({ id: 2, last_successful_sync_at: "2026-02-01T00:00:00+00:00" });
    const older = summary({ id: 3, last_successful_sync_at: "2026-01-15T00:00:00+00:00" });
    const gone = summary({ id: 4, status: "inaccessible", last_successful_sync_at: "2026-03-01T00:00:00+00:00" });
    expect([gone, older, recent, working].sort(bySummaryOrder).map((s) => s.id)).toEqual([1, 2, 3, 4]);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("GET /api/repositories", () => {
  it("lists every registered repository with its counts and active jobs, working ones first, and the capacity", async () => {
    const res = await get("/api/repositories");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/error_message/);
    const body = JSON.parse(text) as RepositoryListResponse;
    const ids = body.repositories.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([ID_IDLE, ID_BUSY, ID_UNDERSCORE]));
    expect(ids.indexOf(ID_BUSY)).toBeLessThan(ids.indexOf(ID_IDLE));
    const busy = body.repositories.find((r) => r.id === ID_BUSY)!;
    expect(busy).toMatchObject({ full_name: "alice/list-busy", status: "registered", passages: 1, embedded: 0, pending: 1, last_successful_sync_at: null });
    expect(busy.active_jobs).toEqual([expect.objectContaining({ kind: "fetch_issues", state: "queued", error_code: null, attempt: 0 })]);
    expect(body.repositories.find((r) => r.id === ID_IDLE)).toMatchObject({ passages: 0, embedded: 0, pending: 0, active_jobs: [] });
    // The capacity counts the rows of this same read, the set the admission check counts.
    expect(body.capacity).toEqual({ used: body.repositories.length, max: MAX_REPOSITORIES });
  });

  it("leaves removed repositories out", async () => {
    await db.from("repositories").update({ status: "removed" }).eq("id", ID_IDLE);
    try {
      const body = (await (await get("/api/repositories")).json()) as RepositoryListResponse;
      expect(body.repositories.map((r) => r.id)).not.toContain(ID_IDLE);
    } finally {
      await db.from("repositories").update({ status: "registered" }).eq("id", ID_IDLE);
    }
  });

  it("GET /api/status says what is deferred, as a list", async () => {
    const status = (await (await get("/api/status")).json()) as ServiceStatus;
    expect(Array.isArray(status.deferred)).toBe(true);
  });
});

describe.skipIf(!env.SUPABASE_SECRET_KEY)("GET /api/repositories/by-name/:owner/:name", () => {
  it("finds a repository by owner/name without case, and treats _ as a letter", async () => {
    const res = await get("/api/repositories/by-name/Alice/List-Idle");
    expect(res.status).toBe(200);
    expect((await res.json()) as RepositoryRecord).toMatchObject({ id: ID_IDLE, full_name: "alice/list-idle" });
    const underscore = await get("/api/repositories/by-name/alice/list_idle");
    expect(underscore.status).toBe(200);
    expect(((await underscore.json()) as RepositoryRecord).id).toBe(ID_UNDERSCORE);
  });

  it("answers 404 for an unknown name and 400 for an invalid one", async () => {
    const missing = await get("/api/repositories/by-name/alice/no-such-repository");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
    expect((await get("/api/repositories/by-name/-bad-/name")).status).toBe(400);
    expect((await get("/api/repositories/by-name/alice/%E0%A4%A")).status).toBe(400);
  });
});
