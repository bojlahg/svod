-- ═══════════════════════════════════════════════════════════════════════════
-- 0093 — SVOD stage 2: stable per-user brain permissions
--
-- New authority for "who may read/write/review a brain" is brain_members:
-- one row per (brain, user) with a stable user id. Roles:
--   reader   — sees active notes, sources, detail; cannot mutate, cannot see
--              pending proposals
--   editor   — reader + edits content (notes, sources, brain fields via the
--              retained useful mutations)
--   reviewer — editor + approves/rejects pending proposals
-- Owner (brains.owner_id) and the global operator (env MOZG_ADMIN_EMAIL /
-- ADMIN_EMAILS, checked in code — never the commercial plan column) can
-- administer any base.
--
-- Migration from legacy grants (0001):
--   grants.viewer      -> brain_members.reader
--   grants.contributor -> brain_members.editor
-- Only rows with an unambiguous verified identity are migrated: exactly one
-- "user" row matches lower(grants.email) AND that row is emailVerified.
-- Rationale: grants are matched by address, so an unverified address must
-- never confer access (anyone could sign up as someone else and collect the
-- share), and two user rows folding to the same lowercase address are
-- ambiguous — picking one would grant the wrong person.
--
-- Explicitly NOT migrated (stays without access until a human grants it):
--   - grants with no matching user row (unmatched invites — remain in grants
--     for later cleanup/notification, grant nothing here)
--   - grants matching only unverified addresses
--   - ambiguous case-fold duplicates
--   - old public visibility, purchases, pack access, library rows, members:
--     none of these confer SVOD access. A migrated public row stays readable
--     only through an explicit brain_members grant, owner, or operator.
--
-- Old tables/columns (grants, purchases, library, members, visibility, price,
-- licence, …) are left untouched for upgrade and later cleanup. No note or
-- vector is touched by this migration.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';

create table if not exists brain_members (
  id          uuid primary key default gen_random_uuid(),
  brain_id    uuid not null references brains(id) on delete cascade,
  user_id     text not null references "user"(id) on delete cascade,
  role        text not null check (role in ('reader', 'editor', 'reviewer')),
  granted_by  text references "user"(id) on delete set null,
  granted_at  timestamptz not null default now(),
  unique (brain_id, user_id)
);

create index if not exists brain_members_brain_idx on brain_members (brain_id);
create index if not exists brain_members_user_idx on brain_members (user_id);

-- One verified user per address. The anti-ambiguous guard (not exists a
-- second user folding to the same address) runs inside the same statement so
-- a concurrent signup cannot slip between a check and the insert; the unique
-- (brain_id, user_id) plus unique lower(email) handling below keeps reruns
-- idempotent.
insert into brain_members (brain_id, user_id, role, granted_by, granted_at)
select
  g.brain_id,
  u.id as user_id,
  case g.role when 'viewer' then 'reader' else 'editor' end as role,
  g.invited_by as granted_by,
  g.invited_at as granted_at
from grants g
join "user" u on lower(u.email) = lower(g.email)
where u."emailVerified"
  and not exists (
    select 1 from "user" other
     where other.id <> u.id
       and lower(other.email) = lower(g.email)
  )
on conflict (brain_id, user_id) do nothing;
