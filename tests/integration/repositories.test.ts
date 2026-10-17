import { env } from "cloudflare:workers";
import { afterAll, expect, it } from "vitest";
import { createDb, getRepository, upsertRepository } from "../../worker/src/api/repositories.ts";
import { repoFixture } from "./helpers.ts";

// Runs against the real Supabase project. Ids sit far above GitHub's range so they
// cannot collide with real repositories, and the rows are removed afterwards. The
// tens digit keeps this file's ids apart from api.test.ts, which runs in parallel.
const ID_A = Date.now() * 100 + 10;
const ID_B = ID_A + 1;
const db = createDb(env);

afterAll(async () => {
  await db.from("repositories").delete().in("id", [ID_A, ID_B]);
});

it.skipIf(!env.SUPABASE_SECRET_KEY)("registers a repository once and deduplicates by GitHub id", async () => {
  const first = await upsertRepository(db, repoFixture({ id: ID_A, full_name: "alice/proj" }));
  expect(first.created).toBe(true);
  expect(first.row).toMatchObject({
    id: ID_A,
    owner: "alice",
    name: "proj",
    full_name: "alice/proj",
    status: "registered",
    submission_count: 1,
  });
  expect(first.row.updated_at).toBe(first.row.created_at);

  // Same id, renamed on GitHub: the row is refreshed, not duplicated.
  const second = await upsertRepository(db, repoFixture({ id: ID_A, full_name: "alice/proj2" }));
  expect(second.created).toBe(false);
  expect(second.row).toMatchObject({
    id: ID_A,
    name: "proj2",
    full_name: "alice/proj2",
    submission_count: 2,
    created_at: first.row.created_at,
  });
  expect(Date.parse(second.row.updated_at)).toBeGreaterThanOrEqual(Date.parse(first.row.updated_at));

  // A different repository that now owns the old name coexists: full_name is not unique.
  const third = await upsertRepository(db, repoFixture({ id: ID_B, full_name: "alice/proj" }));
  expect(third.created).toBe(true);
  expect(third.row).toMatchObject({ id: ID_B, full_name: "alice/proj", submission_count: 1 });

  expect(await getRepository(db, ID_A)).toEqual(second.row);
  expect(await getRepository(db, ID_B + 1)).toBeNull();
});
