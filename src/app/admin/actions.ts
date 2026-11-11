"use server";

import { revalidatePath } from "next/cache";
import { grantWindow } from "@/lib/plans";
import { CRAWL_ROOTS_SQL } from "@/lib/sources";
import { z } from "zod";
import { publishBlocker } from "@/lib/publishable";
import { query, maybeOne } from "@/db";
import { adjustBalance as moveBalance, settlePayout } from "@/lib/money";
import { resolvePlanRequest } from "@/lib/upgrade";
import { requireAdmin } from "@/lib/admin";
import { TOPIC_KEYS } from "@/lib/topics";
import { scanSecrets, scanInjection } from "@/lib/scan";
import { sendOperatorMessage } from "@/lib/operator-chat";
import { settleManually, completeFollowUp } from "@/lib/payments";

/**
 * Operator actions. Each one re-checks requireAdmin() — the page guard runs on
 * render, these run on POST, and nothing stops a POST from arriving without
 * the page ever being rendered.
 */

export async function setPlan(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = z
    .object({
      id: z.string().min(1),
      plan: z.enum(["free", "pro", "team"]),
      // "" is the forever grant; anything else is a whole number of months.
      months: z.coerce.number().int().min(0).max(60).catch(0),
    })
    .safeParse({
      id: formData.get("id"),
      plan: formData.get("plan"),
      months: formData.get("months") || 0,
    });
  if (!parsed.success) return;

  const { id, plan, months } = parsed.data;

  // paid_until is ALWAYS written, never left as it was, and that is the fix
  // for a silent failure rather than a nicety. effectivePlan downgrades a pro
  // or team account to free once paid_until is in the past — so granting pro
  // to somebody whose subscription had lapsed used to set the column and
  // change nothing at all, because the stale date was still sitting there
  // voiding it. The operator saw "pro" in the table and the user stayed on
  // free quotas.
  //
  const until = grantWindow(plan, months);

  await query(
    `update "user"
        set plan = $2,
            paid_until = case when $3::text is null then null
                              else now() + $3::interval end,
            "updatedAt" = now()
      where id = $1`,
    [id, plan, until],
  );
  console.log(
    `[admin] ${admin.email} set plan=${plan}${until ? ` for ${until}` : " (no expiry)"} on ${id}`,
  );
  revalidatePath("/admin/users");
}

/**
 * Move a balance by hand — a refund, a goodwill credit, or correcting a crypto
 * top-up that arrived off-band. Writes a ledger row like every other movement,
 * so `check:money` still reconciles afterwards.
 */
export async function adjustBalance(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = z
    .object({
      id: z.string().min(1),
      // Dollars in, cents stored. Signed: negative takes money back.
      amount: z.coerce.number().min(-10000).max(10000),
      note: z.string().trim().max(200),
    })
    .safeParse({
      id: formData.get("id"),
      amount: String(formData.get("amount") ?? "0").replace(",", "."),
      note: formData.get("note") ?? "",
    });
  if (!parsed.success) return;

  const cents = Math.round(parsed.data.amount * 100);
  if (cents === 0) return;

  const res = await moveBalance({
    userId: parsed.data.id,
    amountCents: cents,
    note: parsed.data.note || `by ${admin.email}`,
  });

  console.log(
    `[admin] ${admin.email} adjusted ${parsed.data.id} by ${cents}c — ${res.ok ? "ok" : "refused"}`,
  );
  revalidatePath("/admin/users");
  revalidatePath("/admin");
}

/**
 * Settle a withdrawal. The money was held when the request was made, so "paid"
 * only closes the row — mark it only after the transfer has actually left.
 * "Rejected" refunds the hold back to the author's balance.
 */
export async function settleWithdrawal(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = z
    .object({ id: z.string().uuid(), paid: z.enum(["yes", "no"]) })
    .safeParse({ id: formData.get("id"), paid: formData.get("paid") });
  if (!parsed.success) return;

  const res = await settlePayout({
    payoutId: parsed.data.id,
    paid: parsed.data.paid === "yes",
    note: `settled by ${admin.email}`,
  });

  console.log(
    `[admin] ${admin.email} settled payout ${parsed.data.id} paid=${parsed.data.paid} — ${res.ok ? "ok" : res.reason}`,
  );
  revalidatePath("/admin");
}

/**
 * Answer a plan request. Approving grants the plan with a 30-day clock (no
 * money moves — this is the off-band payment door); rejecting just closes it.
 */
export async function resolveUpgrade(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = z
    .object({ id: z.string().uuid(), approve: z.enum(["yes", "no"]) })
    .safeParse({ id: formData.get("id"), approve: formData.get("approve") });
  if (!parsed.success) return;

  const res = await resolvePlanRequest({
    requestId: parsed.data.id,
    approve: parsed.data.approve === "yes",
    resolvedBy: admin.email,
  });

  console.log(
    `[admin] ${admin.email} ${parsed.data.approve === "yes" ? "approved" : "rejected"} plan request ${parsed.data.id} — ${res.ok ? "ok" : res.reason}`,
  );
  revalidatePath("/admin");
}

/** Cut a user off from MCP without touching their account or their data. */
export async function revokeTokens(formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id"));

  const revoked = await query<{ id: string }>(
    `update mcp_tokens set revoked_at = now()
      where user_id = $1 and revoked_at is null
      returning id`,
    [id],
  );
  console.log(`[admin] ${admin.email} revoked ${revoked.length} token(s) for ${id}`);
  revalidatePath("/admin/users");
}

/** Where a brain sits in the catalogue: its field and who can see it. */
/** Settle a publication request: approve flips the brain public, reject
    leaves it as it is. Either way the queue row closes. */
export async function settlePublish(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = z
    .object({ id: z.string().uuid(), approve: z.coerce.boolean() })
    .safeParse({ id: formData.get("id"), approve: formData.get("approve") === "yes" });
  if (!parsed.success) return;

  const req = await maybeOne<{ brain_id: string }>(
    `update publish_requests
        set status = $2, resolved_at = now(), resolved_by = $3
      where id = $1 and status = 'pending'
      returning brain_id`,
    [parsed.data.id, parsed.data.approve ? "approved" : "rejected", admin.email],
  );
  if (req && parsed.data.approve) {
    // Approval is the real door, and notes can change between ask and answer
    // — re-scan at the moment of publication, not just at the moment of
    // request. A dirty brain flips the request to rejected instead.
    const notes = await query<{ title: string; body: string }>(
      `select title, body from notes where brain_id = $1 and status = 'active'`,
      [req.brain_id],
    );
    const corpus = notes.map((n) => `${n.title}\n${n.body}`).join("\n\n");
    const dirty = [...scanSecrets(corpus), ...scanInjection(corpus)];
    if (dirty.length) {
      await query(
        `update publish_requests set status = 'rejected',
                resolved_by = $2 where id = $1`,
        [parsed.data.id, `auto: ${[...new Set(dirty.map((d) => d.label))].join(", ")}`],
      );
      console.log(
        `[admin] publish of ${req.brain_id} auto-rejected: ${dirty.map((d) => d.label).join(", ")}`,
      );
    } else {
      // Same gate as the owner's switch: notes can be deleted between the ask
      // and the answer, and an approved empty brain is an empty shelf with a
      // moderator's blessing on it.
      const blocker = await publishBlocker(req.brain_id);
      if (blocker) {
        await query(
          `update publish_requests set status = 'rejected', resolved_by = $2 where id = $1`,
          [parsed.data.id, `auto: ${blocker.slice(0, 60)}`],
        );
        console.log(`[admin] publish of ${req.brain_id} auto-rejected: ${blocker}`);
      } else {
        await query(`update brains set visibility = 'public', updated_at = now() where id = $1`, [
          req.brain_id,
        ]);
      }
    }
  }
  revalidatePath("/admin/brains");
}

export async function setListing(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = z
    .object({
      id: z.string().uuid(),
      visibility: z.enum(["private", "link", "public"]),
      topic: z.string().transform((t) => (TOPIC_KEYS.includes(t) ? t : "other")),
    })
    .safeParse({
      id: formData.get("id"),
      visibility: formData.get("visibility"),
      topic: String(formData.get("topic") ?? "other"),
    });
  if (!parsed.success) return;

  // Taking a brain off the catalogue also takes it off sale: a price on a
  // non-public brain is a listing nobody can complete.
  await query(
    `update brains set visibility = $2, topic = $3,
            price_cents = case when $2 = 'public' then price_cents else 0 end,
            updated_at = now()
      where id = $1`,
    [parsed.data.id, parsed.data.visibility, parsed.data.topic],
  );
  console.log(
    `[admin] ${admin.email} listed ${parsed.data.id} as ${parsed.data.visibility}/${parsed.data.topic}`,
  );
  revalidatePath("/admin/brains");
  revalidatePath("/explore");
}

/**
 * Delete a brain and everything under it. Refused while it has sales — people
 * paid for that access, and deleting it silently takes what they bought.
 */
export async function deleteBrain(formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id"));
  if (!z.string().uuid().safeParse(id).success) return;

  const sold = await query<{ n: number }>(
    `select count(*)::int as n from purchases where brain_id = $1`,
    [id],
  );
  if (sold[0].n > 0) {
    console.log(`[admin] ${admin.email} tried to delete sold brain ${id}`);
    return;
  }

  await query(`delete from brains where id = $1`, [id]);
  console.log(`[admin] ${admin.email} deleted brain ${id}`);
  revalidatePath("/admin/brains");
  revalidatePath("/explore");
}

/**
 * Delete a person. Cascades through their brains, tokens, calls and ledger, so
 * it is refused while they are holding money or have bought something — both
 * are records someone may need to point at later.
 */
export async function deleteUser(formData: FormData) {
  const admin = await requireAdmin();
  const { env } = await import("@/lib/env");
  const id = String(formData.get("id"));
  if (id === admin.id) return; // no locking yourself out

  // The .env bootstrap administrator is never deletable through this UI.
  const target = await query<{ email: string }>(`select email from "user" where id = $1`, [
    id,
  ]);
  if (!target.length) return;
  const boot = (env.MOZG_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (boot && target[0].email.trim().toLowerCase() === boot) {
    console.log(`[admin] ${admin.email} tried to delete the bootstrap administrator`);
    return;
  }

  const rows = await query<{ balance_cents: number; purchases: number; sales: number }>(
    `select u.balance_cents,
            (select count(*)::int from purchases p where p.buyer_id = u.id) as purchases,
            (select count(*)::int from purchases p where p.seller_id = u.id) as sales
       from "user" u where u.id = $1`,
    [id],
  );
  if (!rows.length) return;
  const { balance_cents, purchases, sales } = rows[0];
  if (balance_cents > 0 || purchases > 0 || sales > 0) {
    console.log(`[admin] ${admin.email} tried to delete user ${id} with money history`);
    return;
  }

  await query(`delete from "user" where id = $1`, [id]);
  console.log(`[admin] ${admin.email} deleted user ${id}`);
  revalidatePath("/admin/users");
}

/**
 * Write to a person first — the payments list is where this earns its keep:
 * a stuck invoice is a reason to reach out, not to wait for them to find
 * chatmozg. Lands as an operator message, so the mascot badge and their /chat
 * thread light up exactly like a reply would.
 */
export async function messageUser(formData: FormData) {
  const admin = await requireAdmin();

  const userId = String(formData.get("user_id"));
  const body = String(formData.get("body") ?? "").trim().slice(0, 4000);
  const lang = String(formData.get("lang") ?? "auto");
  if (!userId || !body) return;

  await sendOperatorMessage(userId, body, lang);
  console.log(`[admin] ${admin.email} messaged user ${userId}`);
  revalidatePath("/admin");
  revalidatePath("/admin/chat");
}

/**
 * The mozgpay receiving addresses, editable without a deploy. An empty field
 * clears the override and the env value (if any) takes back over. Only new
 * invoices use the new address — open ones are watched at the address they
 * were issued with, so rotation never strands a payer mid-flight.
 */
const WALLET_FIELDS = [
  { key: "mozgpay_addr_tron", field: "tron", pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ },
  { key: "mozgpay_addr_eth", field: "eth", pattern: /^0x[0-9a-fA-F]{40}$/ },
  { key: "mozgpay_addr_sol", field: "sol", pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
  { key: "mozgpay_addr_btc", field: "btc", pattern: /^(bc1[0-9a-z]{20,70}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/ },
] as const;

export async function saveWallets(
  _prev: unknown,
  formData: FormData,
): Promise<{ saved: string[]; cleared: string[]; rejected: string[]; at: string }> {
  const admin = await requireAdmin();

  const saved: string[] = [];
  const cleared: string[] = [];
  const rejected: string[] = [];

  for (const w of WALLET_FIELDS) {
    const value = String(formData.get(w.field) ?? "").trim();
    if (!value) {
      const gone = await query(
        `delete from app_settings where key = $1 returning key`,
        [w.key],
      );
      if (gone.length) cleared.push(w.field);
      continue;
    }
    // A typo here points real money at the void — refuse anything that does
    // not even look like an address on that chain, and SAY so: a silent skip
    // reads as saved, which is worse than no validation at all.
    if (!w.pattern.test(value)) {
      rejected.push(w.field);
      continue;
    }
    await query(
      `insert into app_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [w.key, value],
    );
    saved.push(w.field);
  }
  console.log(
    `[admin] ${admin.email} wallets: saved=[${saved}] cleared=[${cleared}] rejected=[${rejected}]`,
  );
  revalidatePath("/admin");
  return {
    saved,
    cleared,
    rejected,
    at: new Date().toISOString().slice(11, 16) + " UTC",
  };
}

/**
 * Put a brain's failed sources back on the queue, from the attention list.
 * The usual pairing: fix the cause first (grant a plan, adjust a balance),
 * then press this. Budget-paused sources also resume themselves via the
 * maintenance sweep — this button is for not waiting six hours.
 */
export async function requeueBrainSources(formData: FormData) {
  const admin = await requireAdmin();
  const brainId = String(formData.get("brain_id"));
  if (!brainId) return;

  const rows = await query<{ id: string }>(
    `update sources set status = 'queued', error = null, reject_reason = null
      where brain_id = $1 and status in ('failed', 'rejected')
        and kind not in ${CRAWL_ROOTS_SQL}
      returning id`,
    [brainId],
  );
  const { enqueueIngest, PRIORITY } = await import("@/worker/queue");
  for (const s of rows) await enqueueIngest(s.id, PRIORITY.background);
  console.log(`[admin] ${admin.email} requeued ${rows.length} source(s) on brain ${brainId}`);
  revalidatePath("/admin");
}

/**
 * Close a whole family of errors at once — triage works in kinds, not rows.
 * Resolving is acknowledgement, not deletion: the rows stay for postmortems.
 */
export async function resolveErrors(formData: FormData) {
  const admin = await requireAdmin();
  const source = String(formData.get("source") ?? "");
  const kind = String(formData.get("kind") ?? "");

  if (source === "*") {
    await query(`update app_errors set resolved_at = now() where resolved_at is null`);
  } else if (source && kind) {
    await query(
      `update app_errors set resolved_at = now()
        where source = $1 and kind = $2 and resolved_at is null`,
      [source, kind],
    );
  }
  console.log(`[admin] ${admin.email} resolved errors ${source}/${kind}`);
  revalidatePath("/admin/errors");
}

/**
 * Mark a crypto invoice as received, when the operator can see the money and
 * the watcher could not claim it.
 *
 * Deliberately separate from adjustBalance. A hand-moved balance is a goodwill
 * credit and reads as one; this says "the invoice was paid", closes it, and
 * makes the customer count as having paid in the admin list — which is the
 * difference between a real buyer and, as it looked for a week, a freeloader.
 */
export async function markTopupReceived(formData: FormData) {
  const admin = await requireAdmin();

  const parsed = z
    .object({ reference: z.string().min(1), txId: z.string().max(200).optional() })
    .safeParse({
      reference: formData.get("reference"),
      txId: String(formData.get("txId") ?? "") || undefined,
    });
  if (!parsed.success) return;

  const outcome = await settleManually(parsed.data.reference, {
    txId: parsed.data.txId,
    by: admin.email,
  });
  console.log(
    `[admin] ${admin.email} marked ${parsed.data.reference} received: ` +
      (outcome.credited ? `+${outcome.amountCents}c` : `no-op (${outcome.reason})`),
  );
  if (outcome.credited && outcome.followUp) await completeFollowUp(outcome);
  revalidatePath("/admin/users");
}
