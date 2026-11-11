"use client";

import { useActionState } from "react";
import { useT } from "@/lib/t-client";
import { removeMember } from "./actions";

/** Member removal with visible feedback — a silent plain form is not enough. */
export default function RemoveMember({
  brainId,
  userId,
  slug,
}: {
  brainId: string;
  userId: string;
  slug: string;
}) {
  const t = useT();
  const [state, action, pending] = useActionState(removeMember, null);
  return (
    <form action={action}>
      <input type="hidden" name="brainId" value={brainId} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="slug" value={slug} />
      <button
        className="linkish"
        data-danger="true"
        type="submit"
        disabled={pending}
        aria-label={t("Remove member")}
      >
        {pending ? t("Removing…") : t("remove")}
      </button>
      {state?.error && (
        <span className="mono" style={{ display: "block", color: "var(--color-riso-red)", fontSize: ".75rem" }}>
          {state.error}
        </span>
      )}
    </form>
  );
}
