"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { query } from "@/db";
import { currentUser } from "@/lib/session";
import { requestPayout, MIN_PAYOUT_CENTS } from "@/lib/money";
import { formatCents } from "@/lib/money-math";
import { createInvoice, createOwnInvoice, mozgpayReady } from "@/lib/payments";
import { requestPlanUpgrade, payPlanFromBalance, checkPromo } from "@/lib/upgrade";

/** Handles are a public namespace — /b/{handle}/{slug} — so they are strict. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

const RESERVED = new Set([
  "admin", "api", "b", "beta", "brains", "changelog", "chat", "connect",
  "earn", "explore", "gift", "guide", "make", "mcp", "mind", "pay", "pricing", "r",
  "settings", "sign-in", "sign-up", "vs", "vs-skills", "why", "www",
  "support", "help",
]);

export async function updateProfile(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const parsed = z
    .object({
      name: z.string().trim().min(1, "A name cannot be empty").max(60),
      handle: z
        .string()
        .trim()
        .toLowerCase()
        .regex(HANDLE, "Handles are 3–30 characters: letters, numbers and dashes"),
    })
    .safeParse({ name: formData.get("name"), handle: formData.get("handle") });

  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (RESERVED.has(parsed.data.handle)) {
    return { error: "That handle is reserved." };
  }

  // The unique index is the real guard; this turns a constraint violation into
  // a sentence the person can act on.
  const taken = await query(
    `select 1 from "user" where handle = $1 and id <> $2`,
    [parsed.data.handle, user.id],
  );
  if (taken.length) return { error: "That handle is taken." };

  // Atomic: the pre-check above races a concurrent claim, so the unique
  // violation below maps to the same user-facing answer, not a 500.
  try {
    await query(
      `update "user" set name = $2, handle = $3, "updatedAt" = now() where id = $1`,
      [user.id, parsed.data.name, parsed.data.handle],
    );
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      return { error: "That handle is taken." };
    }
    throw err;
  }

  revalidatePath("/settings");
  return { ok: true as const, handle: parsed.data.handle };
}

export async function askForPayout(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const parsed = z
    .object({
      amount: z.coerce.number().positive("Enter an amount").max(10000),
      destination: z
        .string()
        .trim()
        .min(8, "Where should it go? Paste a wallet address and its network")
        .max(200),
    })
    .safeParse({
      amount: String(formData.get("amount") ?? "").replace(",", "."),
      destination: formData.get("destination"),
    });

  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const res = await requestPayout({
    userId: user.id,
    amountCents: Math.round(parsed.data.amount * 100),
    destination: parsed.data.destination,
  });

  if (!res.ok) {
    return {
      error:
        res.reason === "too-small"
          ? `The smallest withdrawal is ${formatCents(MIN_PAYOUT_CENTS)} — below that the transfer fee eats it.`
          : res.reason === "already-open"
            ? "You already have a withdrawal waiting. It has to be settled first."
            : "That is more than your balance.",
    };
  }

  revalidatePath("/settings/balance");
  return { ok: true as const };
}

export async function startTopUp(
  _prev: unknown,
  formData: FormData,
): Promise<{ payUrl?: string; amountCents?: number; error?: string }> {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const amountCents = Number(formData.get("amount") ?? 0);
  const coin = String(formData.get("coin") ?? "") || undefined;
  // Our own rail first: no middleman, no fee, the author's wallet directly.
  // The gateway stays as the fallback for the day we want hosted checkout.
  const res = mozgpayReady
    ? await createOwnInvoice({ userId: user.id, amountCents, coin })
    : await createInvoice({ userId: user.id, amountCents });

  if (!res.ok) {
    return {
      error:
        res.reason === "unconfigured"
          ? "Top-ups are not switched on yet."
          : res.reason === "amount"
            ? "Pick one of the amounts above."
            : `The payment provider did not answer (${res.reason}). Try again shortly.`,
    };
  }

  revalidatePath("/settings/balance");
  return { payUrl: res.invoice.payUrl, amountCents: res.invoice.amountCents };
}

/* ─── bring your own key ─────────────────────────────────────────────────── */

/**
 * Store (or clear) the user's own AI API key. With one set, their brains
 * train and examine on THEIR spend — the platform's daily budget and exam
 * caps step aside. Stored encrypted; only the last four characters ever
 * come back out.
 */
export async function saveAiKey(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const raw = String(formData.get("key") ?? "").trim();
  const baseUrl = String(formData.get("base_url") ?? "").trim();
  const provider = formData.get("provider") === "openai" ? "openai" : "anthropic";
  const model = String(formData.get("model") ?? "").trim().slice(0, 80);

  if (formData.get("remove") === "yes" || raw === "") {
    await query(
      `update "user" set ai_key_enc = null, ai_key_hint = null, ai_base_url = null,
              ai_provider = 'anthropic', ai_model = null,
              "updatedAt" = now() where id = $1`,
      [user.id],
    );
    return { ok: true as const, removed: true as const };
  }

  if (raw.length < 20 || /\s/.test(raw)) {
    return { error: "That does not look like an API key." };
  }
  if (baseUrl && !/^https:\/\/[^\s]+$/.test(baseUrl)) {
    return { error: "The base URL must be https://…" };
  }
  if (provider === "openai" && !model) {
    return { error: "Name the model for this provider (e.g. gpt-4o-mini, kimi-k2, deepseek-chat)." };
  }

  const { seal } = await import("@/lib/secretbox");
  await query(
    `update "user" set ai_key_enc = $2, ai_key_hint = $3, ai_base_url = $4,
            ai_provider = $5, ai_model = $6,
            "updatedAt" = now() where id = $1`,
    [user.id, seal(raw), raw.slice(-4), baseUrl || null, provider, model || null],
  );
  return { ok: true as const, hint: raw.slice(-4) };
}

/* ─── plan upgrades ──────────────────────────────────────────────────────── */

/** Ask for a plan — an operator switches the account by hand. */
export async function requestUpgrade(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const parsed = z.enum(["pro", "team"]).safeParse(formData.get("plan"));
  if (!parsed.success) return { error: "Unknown plan." };

  const res = await requestPlanUpgrade(user.id, parsed.data);
  if (!res.ok) {
    return { error: "You already have a request waiting — it has to be answered first." };
  }

  revalidatePath("/settings");
  return { ok: true as const, plan: parsed.data };
}

/** Live promo validation for the checkout UI — same truth the payment uses. */
export async function checkPromoAction(
  code: string,
): Promise<{ ok: true; percentOff: number } | { ok: false; message: string }> {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const check = await checkPromo(code, user.id);
  if (check.ok) return { ok: true, percentOff: check.percentOff! };
  return {
    ok: false,
    message: {
      unknown: "That code does not exist.",
      expired: "That code has expired.",
      exhausted: "That code has been fully used.",
      "already-used": "You already used that code.",
    }[check.reason ?? "unknown"],
  };
}

/**
 * Buy a month of the plan from the balance. The price is read inside
 * payPlanFromBalance's own transaction — never from this form.
 */
export async function payUpgrade(_prev: unknown, formData: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const parsed = z.enum(["pro", "team"]).safeParse(formData.get("plan"));
  if (!parsed.success) return { error: "Unknown plan." };

  // A wrong code must fail loudly before money moves — silently charging
  // full price to someone who typed a code is how trust dies.
  const promoCode = String(formData.get("promo") ?? "").trim();
  if (promoCode) {
    const check = await checkPromo(promoCode, user.id);
    if (!check.ok) {
      const why = {
        unknown: "That code does not exist.",
        expired: "That code has expired.",
        exhausted: "That code has been fully used.",
        "already-used": "You already used that code.",
      }[check.reason ?? "unknown"];
      return { error: `Promo code: ${why}` };
    }
  }

  const res = await payPlanFromBalance({
    userId: user.id,
    plan: parsed.data,
    promoCode: promoCode || undefined,
  });
  if (!res.ok) {
    return { error: "Not enough on your balance. Top up below, then pay." };
  }

  revalidatePath("/settings");
  return { ok: true as const, plan: parsed.data, paidCents: res.paidCents };
}
