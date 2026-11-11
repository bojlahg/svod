-- ═══════════════════════════════════════════════════════════════════════════
-- 0096 — SVOD stage 5: section identity, embed state, auto-index, outbox
--
-- Additive only. Existing notes, ids, attachments and `embedding` values are
-- kept and never updated in bulk:
--   - chunks.input_hash (SHA-256 of title + "\n\n" + section slice, UTF-8)
--   - chunks.section_ordinal (position of the section inside its note)
--   - chunks.embed_fingerprint (confirmed fingerprint id that produced the
--     stored vector; NULL = unconfirmed/legacy vector, never semantic)
--   - chunks.embed_error (last embed failure, human-readable prefix)
--   - chunks.embed_state ready|pending|error, default ready so existing rows
--     stay `ready` with NULL fingerprint (unconfirmed vector for Svod).
--   - brains.auto_index default false for old and new bases, so an upgrade
--     never queues the whole corpus by itself.
--   - svod_embed_outbox: source of truth for the queue. One open row per
--     chunk, inserted in the same transaction as the chunk when indexing is
--     actually queued. Deleted by cascade together with the chunk.
--
-- Old chunks have no hash and never match sections: the first real sync of a
-- note replaces them. The migration itself rewrites no chunk rows.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';

-- ─── chunks: section identity + embed state ────────────────────────────────

alter table chunks add column if not exists input_hash text;
alter table chunks add column if not exists section_ordinal int;
alter table chunks add column if not exists embed_fingerprint text;
alter table chunks add column if not exists embed_error text;
alter table chunks add column if not exists embed_state text not null default 'ready';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chunks_embed_state_check') then
    alter table chunks add constraint chunks_embed_state_check
      check (embed_state in ('ready', 'pending', 'error'));
  end if;
end $$;

create index if not exists chunks_note_ordinal_idx on chunks (note_id, section_ordinal);
create index if not exists chunks_input_hash_idx on chunks (input_hash) where input_hash is not null;
create index if not exists chunks_embed_state_idx on chunks (brain_id, embed_state);

-- ─── brains: auto-index switch (default off) ───────────────────────────────

alter table brains add column if not exists auto_index boolean not null default false;

-- ─── outbox: durable queue for section embeddings ─────────────────────────

create table if not exists svod_embed_outbox (
  id          uuid primary key default gen_random_uuid(),
  chunk_id    uuid not null references chunks(id) on delete cascade,
  brain_id    uuid not null references brains(id) on delete cascade,
  note_id     uuid not null references notes(id) on delete cascade,
  input_hash  text not null,
  attempts    int not null default 0 check (attempts >= 0),
  last_error  text,
  not_before  timestamptz not null default now(),
  locked_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique (chunk_id)
);

create index if not exists svod_embed_outbox_due_idx
  on svod_embed_outbox (not_before, created_at)
  where locked_at is null;
create index if not exists svod_embed_outbox_brain_idx on svod_embed_outbox (brain_id);
create index if not exists svod_embed_outbox_note_idx on svod_embed_outbox (note_id);
