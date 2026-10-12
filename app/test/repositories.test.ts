import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { getRepository, upsertRepository } from "../worker/repositories.ts";
import { repoFixture } from "./helpers.ts";

const T0 = "2026-10-12T00:00:00.000Z";
const T1 = "2026-10-12T01:00:00.000Z";

it("registers a repository once and deduplicates by GitHub id", async () => {
  const first = await upsertRepository(env.DB, repoFixture({ id: 1, full_name: "alice/proj" }), T0);
  expect(first.created).toBe(true);
  expect(first.row).toEqual({
    id: 1,
    owner: "alice",
    name: "proj",
    full_name: "alice/proj",
    status: "registered",
    submission_count: 1,
    created_at: T0,
    updated_at: T0,
  });

  // Same id, renamed on GitHub: the row is refreshed, not duplicated.
  const second = await upsertRepository(env.DB, repoFixture({ id: 1, full_name: "alice/proj2" }), T1);
  expect(second.created).toBe(false);
  expect(second.row).toMatchObject({
    id: 1,
    name: "proj2",
    full_name: "alice/proj2",
    submission_count: 2,
    created_at: T0,
    updated_at: T1,
  });

  // A different repository that now owns the old name coexists: full_name is not unique.
  const third = await upsertRepository(env.DB, repoFixture({ id: 2, full_name: "alice/proj" }), T1);
  expect(third.created).toBe(true);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM repositories").first<{ n: number }>();
  expect(count?.n).toBe(2);

  expect(await getRepository(env.DB, 1)).toEqual(second.row);
  expect(await getRepository(env.DB, 999)).toBeNull();
});
