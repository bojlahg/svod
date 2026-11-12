import { betterAuth } from "better-auth";
import { mcp } from "better-auth/plugins";
// Relative, not "@/..." — the better-auth CLI loads this file outside the
// Next.js resolver and does not honour tsconfig path aliases.
import { pool } from "../db";
import { env } from "./env";
import { sendMail } from "./mail";
import { cookies } from "next/headers";
import { captureServer } from "./analytics";

/**
 * Identity. better-auth owns the "user"/"session"/"account"/"verification"
 * tables; app tables FK into "user"(id). Run `npm run auth:migrate` before
 * `npm run db:migrate` on a fresh database.
 */
// learn.mozg.sh is the same product with its own front door, so one session
// must open both. The cookie widens to .mozg.sh only in production — a domain
// cookie on localhost would break dev sign-in.
const onMozg = env.BETTER_AUTH_URL.includes("mozg.sh");

export const auth = betterAuth({
  database: pool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // OAuth for MCP: ChatGPT connectors and other OAuth-only clients discover
  // us via /.well-known, register dynamically, and send users to /sign-in
  // for consent. Bearer mzg_ tokens keep working alongside.
  plugins: [mcp({ loginPage: "/sign-in" })],
  trustedOrigins: onMozg ? ["https://mozg.sh", "https://learn.mozg.sh"] : undefined,
  advanced: onMozg
    ? { crossSubDomainCookies: { enabled: true, domain: ".mozg.sh" } }
    : undefined,

  socialProviders: {
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },

  // SVOD stage 2: public self-registration is closed. Password sign-up is
  // disabled outright (existing local credentials keep working); OAuth
  // sign-ups are refused in databaseHooks below so existing OAuth logins keep
  // working while new public accounts cannot be created. New users are created
  // by the operator in /admin/users, verified at creation, without email APIs.
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: "Reset your svod password",
        text:
          `Someone — hopefully you — asked to reset the password for ${user.email}.\n\n` +
          `Reset it here:\n${url}\n\n` +
          "If this was not you, ignore this mail; the link expires on its own.",
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: "Confirm your svod address",
        text:
          "One click and your account is live — brains shared with this " +
          "address start working the moment it is confirmed:\n\n" +
          `${url}\n\n` +
          "If you did not ask for a svod account, ignore this mail.",
      });
    },
  },

  user: {
    additionalFields: {
      plan: { type: "string", defaultValue: "free", input: false },
      handle: { type: "string", required: false, input: false },
      // When the paid plan runs out (0040). Read via effectivePlan — never
      // trusted on its own. Null on a hand-set plan, which does not expire.
      paidUntil: { type: "date", required: false, input: false, fieldName: "paid_until" },
    },
  },

  databaseHooks: {
    user: {
      create: {
        // SVOD stage 2: refuse public sign-ups, including OAuth. This hook
        // runs only on creation, never on sign-in — existing users (password
        // or OAuth) keep signing in; no new row can be created through the
        // public API. Operator-created users bypass Better Auth entirely
        // (direct SQL + scrypt hash in /admin/users), so they are unaffected.
        before: async () => {
          throw new Error(
            "Self-registration is disabled — ask your administrator for an account.",
          );
        },
        after: async (user) => {
          // Where they came from, read off the first-touch cookie the
          // middleware set on the visit. Best effort on purpose: a signup that
          // failed because attribution failed would be a spectacularly bad
          // trade, so nothing here may throw.
          let source: string | null = null;
          try {
            source = (await cookies()).get("mozg_src")?.value?.slice(0, 60) ?? null;
            if (source) {
              await pool.query(`update "user" set signup_source = $2 where id = $1`, [
                user.id,
                source,
              ]);
            }
          } catch {
            // No request context (a script, a test) or the column is not there
            // yet on a stale deploy. Either way the account matters more.
          }

          // The top of the v1 funnel: signup → first brain_search (PLAN.md).
          captureServer(user.id, "user_signed_up", source ? { source } : undefined);

          // Public namespace for brains: /b/{handle}/{slug}. Derive from the
          // email local part, then disambiguate — the unique index is the
          // real guard, this loop just avoids burning attempts.
          const base =
            (user.email ?? "user")
              .split("@")[0]
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 30) || "user";

          for (let i = 0; i < 20; i++) {
            const candidate = i === 0 ? base : `${base}-${i}`;
            const res = await pool.query(
              `update "user" set handle = $1
                 where id = $2
                   and not exists (select 1 from "user" where handle = $1)`,
              [candidate, user.id],
            );
            if (res.rowCount) return;
          }
        },
      },
    },
    session: {
      create: {
        // Fires on sign-in (and once more on sign-up, which auto-signs in —
        // the events answer different questions, so that is fine).
        after: async (session) => {
          captureServer(session.userId, "user_signed_in");
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
