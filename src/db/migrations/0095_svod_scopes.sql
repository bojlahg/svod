-- ═══════════════════════════════════════════════════════════════════════════
-- 0095 — SVOD stage 4: per-token brain scopes, project bases, proposal edits
--
-- Additive only. Existing brains/notes/vectors/folders untouched:
--   - mcp_tokens.can_create_project (default-off, separate capability)
--   - brains.project_id nullable; NOT NULL = project base, NULL = general base.
--     Keyed by stable external project_id, not display title. Same
--     title/different IDs yield different projects; title never dedupes.
--     Global unique where not null so concurrent creates collide safely.
--     Immutable after creation (trigger), like folders scope.
--   - notes.updated_at (last-updated timestamp) + revision (monotonic integer
--     for stale detection; timestamps lose sub-second precision in node-pg and
--     String(Date) comparisons, so revision is the authority).
--   - notes.target_note_id + target_revision for edit proposals:
--       target_note_id = active note being edited (NULL = new-note proposal)
--       target_revision = target.revision at proposal time (exact integer match)
--       Same-brain enforced NATIVELY via composite FK
--       (brain_id, target_note_id) -> notes (brain_id, id) on delete cascade,
--       backed by unique (brain_id, id). A later UPDATE moving the target to
--       another base is rejected natively while proposals reference it (same
--       class as folder scope). Destination moves on approval never mutate the
--       original target: a moved edit becomes a labeled new-note in the
--       destination base, preserving the original and other pending refs.
--   - notes.revision for every note (active + pending): bumped on every UPDATE
--     via trigger; approve/edit guard on expected proposal revision + source
--     brain at the transaction boundary so a stale reviewer view cannot approve
--     unseen content.
--   - notes.token_id + updated_token_id (source token attribution, survives
--     revocation: revocation is soft (revoked_at), FK is ON DELETE SET NULL
--     only for hard deletes; revoked rows still join for display).
--   - mcp_token_scopes (token_id, brain_id, capability):
--       read    = list/brief/search/read
--       propose = read + propose new notes / edit proposals on any base
--       write   = read + direct-write on PROJECT bases only (plus user canEdit,
--                 intersected in the shared resolver)
--     Default deny: no rows = no access. Revocation/grant updates apply
--     immediately (live resolver, no cache). Legacy unscoped tokens and OAuth
--     (no rows) fail closed.
--     Native FK/unique + trigger for no direct-write grant on a general base.
--
-- Concurrency:
--   - brains.project_id unique where not null => concurrent creates for same
--     project_id resolve to one winner (23505 for loser, handled in code to
--     return existing only to an authorized token, no leaks/grants on conflict).
--   - brains (owner_id, slug) unique => same-title/different-ID concurrent
--     creates retry slug safely within the create flow (distinct from
--     project_id conflict).
--   - mcp_token_scopes unique (token_id, brain_id) => concurrent grants for
--     same pair resolve to one row (upsert in code).
--   - notes.revision enables exact stale-target detection on approval so
--     parallel proposals/edits cannot silently overwrite a later version.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';

-- ─── token create-project capability (default-off) ──────────────────────────

alter table mcp_tokens add column if not exists can_create_project boolean not null default false;

-- ─── project bases keyed by stable external project_id ─────────────────────

alter table brains add column if not exists project_id text;

-- Hygiene: 1-200 chars, trimmed, no CR/LF. NULL = general base.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'brains_project_id_hygiene') then
    alter table brains add constraint brains_project_id_hygiene
      check (project_id is null
             or (char_length(project_id) between 1 and 200
                 and project_id = btrim(project_id)
                 and position(chr(10) in project_id) = 0
                 and position(chr(13) in project_id) = 0));
  end if;
end $$;

-- Global unique: one brain per external project_id. Concurrent creates collide
-- safely (23505), handled in code without leaks.
create unique index if not exists brains_project_id_key
  on brains (project_id) where project_id is not null;

-- Immutable after creation: stable external ID never changes.
create or replace function enforce_brain_project_immutable() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id then
    raise exception 'project_id is immutable' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists brains_project_immutable_trg on brains;
create trigger brains_project_immutable_trg
  before update of project_id on brains
  for each row execute function enforce_brain_project_immutable();

-- ─── notes: updated_at, revision, edit-proposal target, token attribution ──

alter table notes add column if not exists updated_at timestamptz not null default now();
alter table notes add column if not exists revision int not null default 1;
alter table notes add column if not exists target_note_id uuid;
alter table notes add column if not exists target_revision int;
alter table notes add column if not exists token_id uuid references mcp_tokens(id) on delete set null;
alter table notes add column if not exists updated_token_id uuid references mcp_tokens(id) on delete set null;

-- Backing unique for the composite same-brain target FK below.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notes_brain_id_key') then
    alter table notes add constraint notes_brain_id_key unique (brain_id, id);
  end if;
end $$;

-- Native same-brain target: (brain_id, target_note_id) -> notes (brain_id, id).
-- NULL target passes (new-note proposals). A later UPDATE moving the target to
-- another base is rejected natively while any proposal references it, exactly
-- like folder scope. Destination moves on approval create a new note in the
-- destination base instead of mutating the original target.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notes_target_scope_fk') then
    alter table notes add constraint notes_target_scope_fk
      foreign key (brain_id, target_note_id) references notes (brain_id, id)
      on delete cascade;
  end if;
end $$;

create index if not exists notes_target_idx on notes (target_note_id) where target_note_id is not null;
create index if not exists notes_token_idx on notes (token_id) where token_id is not null;
create index if not exists notes_revision_idx on notes (brain_id, revision);

-- Monotonic revision + last-updated touch on every update. Single trigger so
-- the two can never disagree; code never sets revision directly.
create or replace function notes_bump_revision() returns trigger
language plpgsql as $$
begin
  new.revision = old.revision + 1;
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists notes_touch_updated_at_trg on notes;
drop trigger if exists notes_bump_revision_trg on notes;
create trigger notes_bump_revision_trg
  before update on notes
  for each row execute function notes_bump_revision();

-- ─── per-token per-brain scopes ─────────────────────────────────────────────

create table if not exists mcp_token_scopes (
  id          uuid primary key default gen_random_uuid(),
  token_id    uuid not null references mcp_tokens(id) on delete cascade,
  brain_id    uuid not null references brains(id) on delete cascade,
  capability  text not null check (capability in ('read', 'propose', 'write')),
  granted_by  text references "user"(id) on delete set null,
  granted_at  timestamptz not null default now(),
  unique (token_id, brain_id)
);

create index if not exists mcp_token_scopes_token_idx on mcp_token_scopes (token_id);
create index if not exists mcp_token_scopes_brain_idx on mcp_token_scopes (brain_id);

-- No direct-write grant on a general base: write requires brains.project_id.
-- Native enforcement (trigger + FK/unique above), not app-only, so a forged
-- scope flag in code cannot authorize a general-base write (code also checks
-- brains.project_id from DB, never caller input).
create or replace function enforce_token_scope_project_write() returns trigger
language plpgsql as $$
declare
  pid text;
begin
  if new.capability <> 'write' then
    return new;
  end if;
  select project_id into pid from brains where id = new.brain_id;
  if pid is null then
    raise exception 'direct-write grant requires a project base' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists mcp_token_scopes_project_write_trg on mcp_token_scopes;
create trigger mcp_token_scopes_project_write_trg
  before insert or update of brain_id, capability on mcp_token_scopes
  for each row execute function enforce_token_scope_project_write();
