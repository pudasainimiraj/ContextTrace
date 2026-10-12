-- Repositories registered for tracing. Keyed by GitHub's numeric repository id,
-- which is stable across renames and transfers. full_name is the last canonical
-- "owner/name" seen from GitHub and is refreshed on every submission. It is
-- deliberately not UNIQUE: a renamed repository's old name can later belong to a
-- different repository with a different id, and both rows must coexist.
CREATE TABLE repositories (
  id               INTEGER PRIMARY KEY,
  owner            TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  full_name        TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'registered',
  submission_count INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

CREATE INDEX repositories_full_name_idx ON repositories (full_name);
