"use client";

import { useActionState } from "react";
import { useT } from "@/lib/t-client";
import {
  createUser,
  removeBrainRole,
  resetUserPassword,
  setBrainRole,
  updateUser,
} from "./actions";

const field: React.CSSProperties = {
  padding: ".55rem .7rem",
  border: "1.5px solid var(--ink)",
  background: "var(--paper-2)",
  font: "inherit",
  fontSize: ".875rem",
  minWidth: 200,
};

const small: React.CSSProperties = {
  ...field,
  minWidth: 140,
  fontSize: ".8125rem",
  padding: ".4rem .55rem",
};

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return (
    <p className="mono" style={{ color: "var(--color-riso-red)", fontSize: ".75rem", margin: 0 }}>
      {msg}
    </p>
  );
}

export function CreateUserForm() {
  const t = useT();
  const [state, action, pending] = useActionState(createUser, null);
  return (
    <form action={action} style={{ display: "flex", gap: ".6rem", flexWrap: "wrap", alignItems: "flex-end" }}>
      <input name="name" placeholder={t("Name (optional)")} maxLength={60} style={field} />
      <input name="email" type="email" required placeholder={t("user@example.com")} style={field} />
      <input name="password" type="password" required minLength={8} maxLength={128} placeholder={t("Password — 8+ chars")} style={field} autoComplete="new-password" />
      <button className="btn" type="submit" disabled={pending}>
        {pending ? t("Creating…") : t("Create verified user")}
      </button>
      <Err msg={state?.error} />
    </form>
  );
}

export function EditUserForm({ id, name, email }: { id: string; name: string | null; email: string }) {
  const t = useT();
  const [state, action, pending] = useActionState(updateUser, null);
  return (
    <form action={action} style={{ display: "grid", gap: ".3rem" }}>
      <input type="hidden" name="id" value={id} />
      <input name="name" defaultValue={name ?? ""} placeholder={t("Name")} maxLength={60} style={small} />
      <input name="email" type="email" required defaultValue={email} style={small} />
      <button type="submit" disabled={pending}>{pending ? t("Saving…") : t("Save")}</button>
      <Err msg={state?.error} />
    </form>
  );
}

export function ResetPasswordForm({ id }: { id: string }) {
  const t = useT();
  const [state, action, pending] = useActionState(resetUserPassword, null);
  return (
    <form action={action} style={{ display: "grid", gap: ".3rem" }}>
      <input type="hidden" name="id" value={id} />
      <input name="password" type="password" required minLength={8} maxLength={128} placeholder={t("New password")} style={small} autoComplete="new-password" />
      <button type="submit" disabled={pending}>{pending ? t("Resetting…") : t("Reset + revoke sessions")}</button>
      <Err msg={state?.error} />
    </form>
  );
}

export function RoleForm({
  userId,
  brains,
  label,
}: {
  userId: string;
  brains: { id: string; title: string; slug: string; owner_handle: string | null }[];
  label: { base: string; reader: string; editor: string; reviewer: string; grant: string };
}) {
  const [state, action, pending] = useActionState(setBrainRole, null);
  return (
    <form action={action} style={{ display: "grid", gap: ".3rem" }}>
      <input type="hidden" name="userId" value={userId} />
      <select name="brainId" required defaultValue="" style={small}>
        <option value="" disabled>{label.base}</option>
        {brains.map((b) => (
          <option key={b.id} value={b.id}>
            {b.owner_handle ? `${b.owner_handle}/` : ""}{b.slug} — {b.title.slice(0, 40)}
          </option>
        ))}
      </select>
      <select name="role" defaultValue="reader" style={small}>
        <option value="reader">{label.reader}</option>
        <option value="editor">{label.editor}</option>
        <option value="reviewer">{label.reviewer}</option>
      </select>
      <button type="submit" disabled={pending}>{label.grant}</button>
      <Err msg={state?.error} />
    </form>
  );
}

export function RemoveRoleForm({ userId, brainId, label }: { userId: string; brainId: string; label: string }) {
  const [state, action, pending] = useActionState(removeBrainRole, null);
  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="brainId" value={brainId} />
      <button
        className="mono"
        style={{ background: "none", border: 0, padding: 0, color: "var(--color-riso-red)", fontSize: ".6875rem", cursor: "pointer", textDecoration: "underline" }}
        type="submit"
        disabled={pending}
        aria-label={label}
      >
        {label}
      </button>
      {state?.error && (
        <span className="mono" style={{ display: "block", color: "var(--color-riso-red)", fontSize: ".6875rem" }}>
          {state.error}
        </span>
      )}
    </form>
  );
}
