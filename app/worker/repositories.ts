import type { RepositoryRecord } from "../shared/api.ts";
import type { GitHubRepo } from "./github-api.ts";

// One atomic upsert keyed by GitHub's repo id. A repeated submission refreshes
// the name columns and bumps submission_count instead of inserting a second row,
// so a concurrent double submit yields exactly one "created" result.
const UPSERT_SQL = `
INSERT INTO repositories (id, owner, name, full_name, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  owner = excluded.owner,
  name = excluded.name,
  full_name = excluded.full_name,
  updated_at = excluded.updated_at,
  submission_count = repositories.submission_count + 1
RETURNING *`;

export async function upsertRepository(
  db: D1Database,
  repo: GitHubRepo,
  now: string = new Date().toISOString(),
): Promise<{ row: RepositoryRecord; created: boolean }> {
  const row = await db
    .prepare(UPSERT_SQL)
    .bind(repo.id, repo.owner.login, repo.name, repo.full_name, now, now)
    .first<RepositoryRecord>();
  if (!row) throw new Error("repositories upsert returned no row");
  return { row, created: row.submission_count === 1 };
}

export async function getRepository(
  db: D1Database,
  id: number,
): Promise<RepositoryRecord | null> {
  return db.prepare("SELECT * FROM repositories WHERE id = ?").bind(id).first<RepositoryRecord>();
}
