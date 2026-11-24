"use client";

import { useT } from "@/lib/t-client";
import {
  clearSvodUnsavedDraftForNavigation,
  confirmSvodDiscard,
} from "./svod-draft-guard";

/** Base switcher: draft-guarded client navigation to the chosen base. */
export default function SvodBasePicker({
  bases,
  currentId,
}: {
  bases: { id: string; title: string; member_role: string }[];
  currentId: string;
}) {
  const t = useT();
  return (
    <select
      aria-label={t("Base")}
      value={currentId}
      onChange={(e) => {
        if (!confirmSvodDiscard(t)) {
          e.target.value = currentId;
          return;
        }
        // Explicit switch after confirmation: clear synchronously so the
        // ensuing hard navigation does not fire a second beforeunload.
        clearSvodUnsavedDraftForNavigation();
        window.location.assign(`/brains/${e.target.value}`);
      }}
    >
      {bases.map((b) => (
        <option key={b.id} value={b.id}>
          {b.title}
        </option>
      ))}
    </select>
  );
}
