import { notFound } from "next/navigation";
import { query } from "@/db";
import { env } from "@/lib/env";
import { currentUser, type SessionUser } from "@/lib/session";
import { embedHealthy } from "@/lib/embed";
import type { Plan, Visibility } from "@/db/types";

/**
 * The operator's view. Everything here reads or writes other people's data, so
 * every entry point calls requireAdmin() again — a page guard is not a
 * substitute for a guard on the action it renders.
 */

const extraAdmins = env.MOZG_ADMIN_EMAIL ? [env.MOZG_ADMIN_EMAIL] : [];

const ADMINS = new Set(
  [...env.ADMIN_EMAILS.split(","), ...extraAdmins]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function isAdmin(user: SessionUser | null): boolean {
  return !!user && ADMINS.has(user.email.toLowerCase());
}

/**
 * Admin or nothing. 404, not 403: a stranger should not learn that /admin
 * exists, and a signed-in user should not learn they are one permission away
 * from it.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await currentUser();
  if (!isAdmin(user)) notFound();
  return user!;
}

/* ─── health ─────────────────────────────────────────────────────────────── */

export interface Health {
  database: boolean;
  embeddings: boolean;
  /** Sources that have been "processing" for over an hour: a dead worker. */
  stuck: number;
  pending: number;
  /** MCP calls in the last 5 minutes — is anything actually connected? */
  callsLive: number;
  callsDay: number;
  failuresDay: number;
}

export async function health(): Promise<Health> {
  const dbOk = await query("select 1").then(
    () => true,
    () => false,
  );

  const embeddings = await embedHealthy();
  if (!dbOk) {
    return {
      database: false,
      embeddings,
      stuck: 0,
      pending: 0,
      callsLive: 0,
      callsDay: 0,
      failuresDay: 0,
    };
  }

  const rows = await query<Omit<Health, "database" | "embeddings">>(
    `select
       (select count(*) filter (where status = 'processing'
          and coalesce(processing_at, created_at) < now() - interval '1 hour')::int
          from sources) as stuck,
       (select count(*) filter (where status in ('queued','processing'))::int
          from sources) as pending,
       (select count(*)::int from calls
          where created_at > now() - interval '5 minutes') as "callsLive",
       (select count(*)::int from calls
          where created_at > now() - interval '24 hours') as "callsDay",
       (select count(*)::int from calls
          where created_at > now() - interval '24 hours' and not ok) as "failuresDay"`,
  );

  return { database: true, embeddings, ...rows[0] };
}

/* ─── people ─────────────────────────────────────────────────────────────── */

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  handle: string | null;
  plan: Plan;
  /** When a granted plan lapses. Null means it does not — see effectivePlan. */
  paid_until: Date | null;
  email_verified: boolean;
  balance_cents: number;
  /** Everything ever credited as a top-up — what they actually paid us. */
  topped_up_cents: number;
  /** What went back out of the balance again, payouts excluded. */
  spent_cents: number;
  brains: number;
  notes: number;
  tokens: number;
  calls_week: number;
  /** Null when this user has never made an MCP call. */
  last_call: string | null;
  created_at: string;
  /** First-touch origin. Null for accounts created before it was recorded. */
  signup_source: string | null;
}

export async function adminUsers(limit = 200): Promise<AdminUser[]> {
  return query<AdminUser>(
    `select u.id, u.email, u.name, u.handle, u.plan, u.paid_until, u.signup_source,
            u."emailVerified" as email_verified, u.balance_cents,
            -- A balance answers "how much is left", never "what for". Both
            -- sides of the account, so a top-up that went somewhere is visible
            -- as a number before anyone opens the history.
            (select coalesce(sum(l.amount_cents), 0)::int from ledger l
              where l.user_id = u.id and l.kind = 'topup') as topped_up_cents,
            (select coalesce(-sum(l.amount_cents), 0)::int from ledger l
              where l.user_id = u.id and l.amount_cents < 0
                and l.kind <> 'payout') as spent_cents,
            (select count(*)::int from brains b where b.owner_id = u.id) as brains,
            (select coalesce(sum(note_count), 0)::int from brains b
              where b.owner_id = u.id) as notes,
            -- Both doors into MCP: CLI bearer tokens AND the OAuth connector
            -- (claude.ai). Counting only mcp_tokens showed an active OAuth
            -- user as "no token" while their 16 calls sat in the next column.
            (select count(*)::int from mcp_tokens t
              where t.user_id = u.id and t.revoked_at is null)
            + (select count(*)::int from "oauthAccessToken" o
                where o."userId" = u.id) as tokens,
            (select count(*)::int from calls c
              where c.caller_id = u.id
                and c.created_at > now() - interval '7 days') as calls_week,
            to_char((select max(created_at) from calls c where c.caller_id = u.id)
                      at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_call,
            to_char(u."createdAt" at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
       from "user" u
      order by u."createdAt" desc
      limit $1`,
    [limit],
  );
}

/* ─── brains ─────────────────────────────────────────────────────────────── */

export interface AdminBrain {
  id: string;
  slug: string;
  title: string;
  topic: string;
  visibility: Visibility;
  price_cents: number;
  sales_count: number;
  note_count: number;
  source_count: number;
  score: number | null;
  owner_id: string;
  owner_email: string;
  owner_handle: string | null;
  failed_sources: number;
  updated_at: string;
}

export async function adminBrains(limit = 200): Promise<AdminBrain[]> {
  return query<AdminBrain>(
    `select b.id, b.slug, b.title, b.topic, b.visibility, b.price_cents, b.sales_count,
            b.note_count, b.source_count, b.score,
            u.id as owner_id, u.email as owner_email, u.handle as owner_handle,
            (select count(*)::int from sources s
              where s.brain_id = b.id and s.status in ('failed','rejected'))
              as failed_sources,
            to_char(b.updated_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
       from brains b join "user" u on u.id = b.owner_id
      order by b.updated_at desc
      limit $1`,
    [limit],
  );
}

/* ─── money ──────────────────────────────────────────────────────────────── */

export interface AdminMoney {
  topped_up: number;
  spent: number;
  to_authors: number;
  platform_cut: number;
  outstanding: number;
  purchases: number;
}

export interface ToolReach {
  /** Distinct accounts whose agents called anything this week. */
  active: number;
  /** …of those, how many ever searched. */
  searched: number;
  /** …how many ever wrote a note back. */
  wrote: number;
  /** …how many left a baton for the next session. */
  handed: number;
}

/**
 * Does any of the persuasion actually work?
 *
 * Four layers exist to make an agent reach for a brain unprompted — the server
 * instructions, the tool descriptions, the session-start hook, the CLAUDE.md
 * import — and not one of them was measured. Sharpening the wording of four
 * unmeasured layers is how a product accumulates rituals: every change feels
 * like an improvement and none of them can be wrong.
 *
 * This is the number that can be wrong. An account whose agent connects and
 * only ever calls brain_list has a brain it never asks — that is the failure,
 * and it is invisible in a total call count, which the very same agent inflates
 * by listing every session.
 *
 * Distinct accounts rather than calls, on purpose: one enthusiastic agent
 * making four hundred searches must not read as adoption.
 */
export async function toolReach(): Promise<ToolReach> {
  const [row] = await query<ToolReach>(
    `select
       count(distinct caller_id)::int as active,
       count(distinct caller_id) filter (where tool = 'brain_search')::int as searched,
       count(distinct caller_id) filter (where tool in ('brain_write', 'brain_write_batch'))::int as wrote,
       count(distinct caller_id) filter (where tool = 'brain_handoff')::int as handed
     from calls
    where created_at > now() - interval '7 days'`,
  );
  return row ?? { active: 0, searched: 0, wrote: 0, handed: 0 };
}

/**
 * The ledger, not the balances. `outstanding` is what users are holding and we
 * therefore owe — the number that matters if anyone ever asks for a payout.
 */
export async function adminMoney(): Promise<AdminMoney> {
  const rows = await query<AdminMoney>(
    `select
       coalesce(sum(amount_cents) filter (where kind = 'topup'), 0)::int as topped_up,
       coalesce(-sum(amount_cents) filter (where kind = 'purchase'), 0)::int as spent,
       coalesce(sum(amount_cents) filter (where kind = 'earning'), 0)::int as to_authors,
       coalesce(-sum(amount_cents) filter (where kind = 'purchase'), 0)::int
         - coalesce(sum(amount_cents) filter (where kind = 'earning'), 0)::int
         as platform_cut,
       (select coalesce(sum(balance_cents), 0)::int from "user") as outstanding,
       (select count(*)::int from purchases) as purchases
     from ledger`,
  );
  return rows[0];
}

export interface AdminPayout {
  id: string;
  email: string;
  handle: string | null;
  amount_cents: number;
  balance_cents: number;
  destination: string;
  requested_at: string;
}

/** Withdrawals waiting on a human to send crypto and mark them paid. */
export async function openPayouts(): Promise<AdminPayout[]> {
  return query<AdminPayout>(
    `select p.id::text, u.email, u.handle, p.amount_cents, u.balance_cents,
            p.destination,
            to_char(p.requested_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as requested_at
       from payouts p join "user" u on u.id = p.user_id
      where p.status = 'requested'
      order by p.requested_at`,
  );
}

export interface AdminPlanRequest {
  id: string;
  email: string;
  handle: string | null;
  plan: string;
  balance_cents: number;
  created_at: string;
}

/** Plan upgrades waiting on a human to approve or reject. */
export async function openPlanRequests(): Promise<AdminPlanRequest[]> {
  return query<AdminPlanRequest>(
    `select r.id::text, u.email, u.handle, r.plan, u.balance_cents,
            to_char(r.created_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
       from plan_requests r join "user" u on u.id = r.user_id
      where r.status = 'pending'
      order by r.created_at`,
  );
}

export interface AdminUserMovement {
  id: string;
  user_id: string;
  amount_cents: number;
  kind: string;
  note: string | null;
  brain_title: string | null;
  brain_slug: string | null;
  created_at: string;
}

/**
 * Every account's money, in one query rather than one per row.
 *
 * The People table said someone was holding $21 and nothing about where it
 * went — the global feed on /admin answers "what happened lately", never "what
 * did this person buy". Newest `perUser` movements each, so one heavy buyer
 * cannot push everybody else's history out of the page.
 */
export async function adminUserMovements(
  userIds: string[],
  perUser = 12,
): Promise<AdminUserMovement[]> {
  if (!userIds.length) return [];
  return query<AdminUserMovement>(
    `select id::text, user_id, amount_cents, kind, note, brain_title, brain_slug,
            created_at
       from (
         select l.id, l.user_id, l.amount_cents, l.kind, l.note,
                b.title as brain_title, b.slug as brain_slug,
                to_char(l.created_at at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
                row_number() over (partition by l.user_id order by l.id desc) as rn
           from ledger l
           left join brains b on b.id = l.brain_id
          where l.user_id = any($1::text[])
       ) m
      where rn <= $2
      order by user_id, id desc`,
    [userIds, perUser],
  );
}

export interface AdminLedgerRow {
  id: string;
  email: string;
  amount_cents: number;
  kind: string;
  note: string | null;
  brain_title: string | null;
  created_at: string;
}

export async function adminLedger(limit = 25): Promise<AdminLedgerRow[]> {
  return query<AdminLedgerRow>(
    `select l.id::text, u.email, l.amount_cents, l.kind, l.note,
            b.title as brain_title,
            to_char(l.created_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
       from ledger l
       join "user" u on u.id = l.user_id
       left join brains b on b.id = l.brain_id
      order by l.id desc limit $1`,
    [limit],
  );
}

export interface AdminOpenInvoice {
  user_id: string;
  reference: string;
  amount_cents: number;
  status: string;
  pay_coin: string | null;
  pay_amount: string | null;
  created_at: string;
}

/**
 * Invoices that were started and never settled — the operator's inbox.
 *
 * Failed ones are included, and they are the point: an expired invoice is
 * exactly the row a human has to look at, because the money may well have
 * arrived after the deadline or in an amount the watcher would not claim.
 * Once a payment stops being visible here it stops being chased at all, which
 * is how a paying customer sat in the list for a week reading "paid in: —".
 */
export async function adminOpenInvoices(userIds: string[]): Promise<AdminOpenInvoice[]> {
  if (!userIds.length) return [];
  return query<AdminOpenInvoice>(
    `select user_id, reference, amount_cents, status, pay_coin, pay_amount::text,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as created_at
       from topups
      where user_id = any($1::text[]) and status <> 'paid'
      order by created_at desc`,
    [userIds],
  );
}
