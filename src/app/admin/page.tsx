import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** SVOD stage 7: operator console is people only. */
export default function AdminPage() {
  redirect("/admin/users");
}
