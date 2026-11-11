-- ═══════════════════════════════════════════════════════════════════════════
-- 0094 — SVOD stage 3: folders in a base, note folder link
--
-- Additive only. Existing brains/notes/vectors untouched:
--   - new table folders (id stable, brain scope, optional parent set once)
--   - notes.folder_id nullable; NULL = base root, so every existing note
--     stays where it was (at the root) with the same id, title, body.
--
-- Enforcement is native composite same-base foreign keys (not triggers):
--   - folders(brain_id, id) is unique so children can reference the pair
--   - folders(brain_id, parent_id) -> folders(brain_id, id) on delete cascade
--     (NULL parent passes; a parent in another base is rejected by the FK)
--   - notes(brain_id, folder_id) -> folders(brain_id, id) on delete set null
--     (folder_id) — only the link is nulled, the note keeps its base scope.
--     Deleting a folder reparents its notes to the root (still active).
--   - folders.brain_id and folders.parent_id are immutable after creation
--     (trigger): with no folder moves, concurrent moves cannot create cycles.
--     Only folder creation (with parent chosen once) and rename, plus note
--     moves between folders, exist in the app.
--   - root/sibling name uniqueness via two partial unique indexes
--     (Postgres treats NULL as distinct, so one index cannot cover both):
--       root    (parent_id is null):     unique (brain_id, name)
--       nested  (parent_id is not null): unique (brain_id, parent_id, name)
--   - name is trimmed, 1-120 chars, no "/", no backslash, no CR/LF,
--     not "." or ".." (paths use " / ").
--
-- Concurrency: uniqueness is enforced by the indexes above, so two concurrent
-- creates with the same name resolve to exactly one winner (unique violation
-- for the loser). Renames lock the folder row (SELECT ... FOR UPDATE in the
-- action). IDs are never reused: moves keep notes.id, renames keep folders.id.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';

create table if not exists folders (
  id         uuid primary key default gen_random_uuid(),
  brain_id   uuid not null references brains(id) on delete cascade,
  parent_id  uuid,
  name       text not null
             check (char_length(name) between 1 and 120)
             check (name = btrim(name))
             check (position('/' in name) = 0)
             check (position('\' in name) = 0)
             check (position(chr(10) in name) = 0)
             check (position(chr(13) in name) = 0)
             check (name not in ('.', '..')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Referenced by the composite same-base keys below.
create unique index if not exists folders_brain_id_key on folders (brain_id, id);

-- Scoped parent: (brain_id, parent_id) must exist as (brain_id, id).
-- NULL parent_id passes (root). Cross-base parents are rejected natively.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'folders_parent_scope_fk') then
    alter table folders add constraint folders_parent_scope_fk
      foreign key (brain_id, parent_id) references folders (brain_id, id)
      on delete cascade;
  end if;
end $$;

create index if not exists folders_brain_idx on folders (brain_id, parent_id);
create index if not exists folders_parent_idx on folders (parent_id) where parent_id is not null;

-- Root names unique per base; sibling names unique per parent. Two partial
-- indexes because (brain_id, parent_id, name) with parent_id NULL would let
-- two roots share a name (NULL <> NULL in a unique index).
create unique index if not exists folders_root_name_key
  on folders (brain_id, name) where parent_id is null;
create unique index if not exists folders_sibling_name_key
  on folders (brain_id, parent_id, name) where parent_id is not null;

-- Immutable scope: brain_id/parent_id are set once at creation. No folder
-- moves in the app, so a concurrent move cannot wedge a cycle.
create or replace function enforce_folder_immutable_scope() returns trigger
language plpgsql as $$
begin
  if new.brain_id is distinct from old.brain_id
     or new.parent_id is distinct from old.parent_id then
    raise exception 'folder scope is immutable' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists folders_immutable_scope_trg on folders;
create trigger folders_immutable_scope_trg
  before update of brain_id, parent_id on folders
  for each row execute function enforce_folder_immutable_scope();

-- Optional link: NULL = base root. Existing rows stay NULL (root) untouched.
alter table notes add column if not exists folder_id uuid;
create index if not exists notes_folder_idx on notes (brain_id, folder_id);

-- Scoped note folder: (brain_id, folder_id) must exist as (brain_id, id).
-- NULL folder passes (root). Cross-base folders are rejected natively.
-- Deleting a folder nulls only folder_id — the note keeps its base scope
-- (a bare ON DELETE SET NULL would null the whole composite pair and trip
-- the NOT NULL on notes.brain_id; PG17 rejects the delete with 23502).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notes_folder_scope_fk') then
    alter table notes add constraint notes_folder_scope_fk
      foreign key (brain_id, folder_id) references folders (brain_id, id)
      on delete set null (folder_id);
  end if;
end $$;
