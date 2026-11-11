import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

/** SVOD stage 2: collective search is retired — workspace only. */
export default async function CollectivePage() {
  const user = await currentUser();
  if (user) redirect("/brains");
  redirect("/sign-in");
}
