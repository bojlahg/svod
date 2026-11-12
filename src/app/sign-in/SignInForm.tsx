"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/t-client";
import { markup } from "@/lib/markup";
import { msg } from "@/lib/msg";
import { signIn, signUp } from "@/lib/auth-client";

/**
 * Errors here say what happened and what to do about it. "Invalid credentials"
 * is technically true and useless — the two cases (wrong password, no account)
 * need different next steps from the person reading it.
 */
function humanError(message: string | undefined, mode: "in" | "up"): string {
  const m = (message ?? "").toLowerCase();

  if (m.includes("invalid") && m.includes("password")) {
    return msg("That password does not match. Try again, or create an account if you have not yet.");
  }
  if (m.includes("user") && (m.includes("not found") || m.includes("exist"))) {
    return mode === "in"
      ? msg("No account with that email. Create one below.")
      : msg("That email is already registered — sign in instead.");
  }
  if (m.includes("already")) {
    return msg("That email is already registered — sign in instead.");
  }
  if (m.includes("password") && m.includes("short")) {
    return msg("Passwords need at least 8 characters.");
  }
  return message || msg("That did not work. Try again.");
}

export default function SignInForm({
  githubEnabled,
  googleEnabled,
  signUpEnabled,
}: {
  githubEnabled: boolean;
  googleEnabled: boolean;
  /** SVOD stage 2: public sign-up is closed — new users are created by the operator. */
  signUpEnabled: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/brains";

  const t = useT();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result =
      mode === "in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: email.split("@")[0] });

    setBusy(false);
    if (result.error) setError(humanError(result.error.message, mode));
    else router.push(next);
  }

  return (
    <main className="shell" style={{ paddingBlock: "clamp(3rem, 9vw, 6rem)", maxWidth: 460 }}>
      <Link href="/" className="wordmark" style={{ display: "inline-block" }}>
        {markup(t("svod<0>.</0>"), [
        <span key="s0" />,
      ])}</Link>

      <h1 className="h1" style={{ margin: "1.5rem 0 .5rem" }}>
        {mode === "in" ? t("Sign in") : t("Create an account")}
      </h1>
      <p style={{ color: "var(--ink-2)", marginTop: 0, marginBottom: ".75rem" }}>
        {mode === "in"
          ? t("Your brains and the agents connected to them.")
          : t("One brain free, no card. Upgrade when you hit the limit.")}
      </p>

      {/* Says plainly whose account this is. Written for humans, and it
          happens to be what an anti-phishing classifier looks for: a new
          domain with a password field and no stated identity is the exact
          shape of a credential-harvesting page. */}
      <p className="mono" style={{ fontSize: ".75rem", color: "var(--ink-3)", marginTop: 0, marginBottom: "1.5rem" }}>
        {t("This is a private svod base. We never ask for another service's password.")}
      </p>

      {(githubEnabled || googleEnabled) && (
        <>
          {googleEnabled && (
            <button
              className="btn btn-ghost"
              style={{ width: "100%", justifyContent: "center", marginBottom: githubEnabled ? ".75rem" : 0 }}
              onClick={() => signIn.social({ provider: "google", callbackURL: next })}
              type="button"
            >
              {t("Continue with Google")}
            </button>
          )}
          {githubEnabled && (
          <button
            className="btn btn-ghost"
            style={{ width: "100%", justifyContent: "center" }}
            onClick={() => signIn.social({ provider: "github", callbackURL: next })}
            type="button"
          >
            {t("Continue with GitHub")}
          </button>
          )}

          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: ".75rem",
              margin: "1.5rem 0",
              fontSize: ".75rem",
              color: "var(--ink-3)",
            }}
          >
            <span style={{ flex: 1, borderTop: "1px solid var(--rule)" }} />
            {t("or")}
            <span style={{ flex: 1, borderTop: "1px solid var(--rule)" }} />
          </div>
        </>
      )}

      <form onSubmit={submit} style={{ display: "grid", gap: "1rem" }}>
        <input
          type="email"
          required
          autoComplete="email"
          placeholder={t("you@example.com")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={field}
        />
        <input
          type="password"
          required
          minLength={8}
          autoComplete={mode === "in" ? "current-password" : "new-password"}
          placeholder={t("Password — at least 8 characters")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={field}
        />

        {error && (
          <p
            className="mono"
            style={{ color: "var(--color-riso-red)", fontSize: ".8125rem", margin: 0 }}
          >
            {t(error)}
          </p>
        )}

        <button
          className="btn"
          type="submit"
          disabled={busy}
          style={{ justifyContent: "center" }}
        >
          {busy ? t("Working…") : mode === "in" ? t("Sign in") : t("Create account")}
        </button>
      </form>

      {signUpEnabled ? (
        <button
          type="button"
          onClick={() => {
            setMode(mode === "in" ? "up" : "in");
            setError(null);
          }}
          className="mono"
          style={{
            marginTop: "1.25rem",
            background: "none",
            border: 0,
            padding: 0,
            color: "var(--ink-2)",
            fontSize: ".8125rem",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {mode === "in"
            ? t("No account yet? Create one")
            : t("Already have an account? Sign in")}
        </button>
      ) : (
        /* SVOD: no public registration. Accounts are created by the
           administrator; existing credentials keep working. */
        <p
          className="mono"
          style={{ marginTop: "1.25rem", fontSize: ".75rem", color: "var(--ink-3)", maxWidth: "42ch" }}
        >
          {t(
            "New here? Ask your administrator for an account — public registration is closed.",
          )}
        </p>
      )}
    </main>
  );
}

const field: React.CSSProperties = {
  width: "100%",
  padding: ".7rem .85rem",
  border: "1px solid var(--rule)",
  background: "var(--paper-2)",
  color: "var(--ink)",
  font: "inherit",
  fontSize: "1rem",
};
