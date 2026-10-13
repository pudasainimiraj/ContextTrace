-- One row per transformed conversation thread (issue or pull request). document_id embeds
-- GitHub's numeric repository id, so it survives renames and transfers like repositories.id.
-- sources_fetched_at is the newest sources.fetched_at the transform read; a thread is
-- re-transformed when a newer source row exists or transform_version changed.
create table public.documents (
  document_id        text        primary key,     -- github:{repository_id}:{type}:{number}
  repository_id      bigint      not null references public.repositories (id) on delete cascade,
  type               text        not null check (type in ('issue', 'pull_request')),
  number             integer     not null,
  title              text        not null,
  transform_version  text        not null,        -- normalizer/chunker/tokenizer/budget version
  sources_fetched_at timestamptz not null,        -- max(sources.fetched_at) of the rows used
  transformed_at     timestamptz not null default now(),
  unique (repository_id, number)
);

-- Embedding-ready passages. Each comes from exactly one source unit (the opening body or
-- one comment); passage_id is derived from the document, the unit and the chunk index, so
-- it is stable across runs. token_count is the model input length: [CLS] + text + [SEP]
-- counted with the vendored bge-small-en-v1.5 WordPiece tokenizer. content_hash is the
-- SHA-256 of text; the embedding job compares it to decide what to re-embed.
create table public.passages (
  passage_id        text        primary key,      -- {document_id}:body:{i} | {document_id}:{source_type}:{source_github_id}:{i}
  document_id       text        not null references public.documents (document_id) on delete cascade,
  repository_id     bigint      not null,
  source_type       text        not null
                    check (source_type in ('issue', 'pull_request', 'issue_comment', 'review_comment')),
  source_github_id  bigint      not null,
  chunk_index       integer     not null check (chunk_index >= 0),
  chunk_count       integer     not null check (chunk_count > chunk_index),
  token_count       integer     not null check (token_count >= 0),
  tokenizer         text        not null,         -- 'BAAI/bge-small-en-v1.5'
  locator           text        not null,         -- 'Opening body', 'Comment 2 of 5 (part 1 of 3)', ...
  author            text,
  created_at        timestamptz not null,         -- GitHub creation time of the source unit
  source_url        text        not null,         -- permalink of the source unit
  text              text        not null,
  text_kind         text        not null check (text_kind in ('normalized_markdown')),
  content_hash      text        not null check (content_hash ~ '^[0-9a-f]{64}$'),
  transform_version text        not null,
  updated_at        timestamptz not null default now(),
  foreign key (repository_id, source_type, source_github_id)
    references public.sources (repository_id, type, github_id) on delete cascade
);

create index passages_document_idx on public.passages (document_id);
-- Backs the composite foreign key and per-repository scans (the embedding job's seam).
create index passages_source_idx on public.passages (repository_id, source_type, source_github_id);

alter table public.documents enable row level security;
alter table public.passages enable row level security;
grant select, insert, update, delete on table public.documents, public.passages to service_role;
revoke all on table public.documents, public.passages from anon, authenticated;
