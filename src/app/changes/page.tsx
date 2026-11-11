import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** SVOD stage 2: the global public diff feed is retired with the catalogue. */
export default async function GlobalChangesPage() {
  const user = await currentUser();
  if (user) redirect("/brains");
  redirect("/sign-in");
}
