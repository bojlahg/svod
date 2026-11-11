import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** SVOD stage 2: the public catalogue is retired — workspace only. */
export default async function ExplorePage() {
  const user = await currentUser();
  if (user) redirect("/brains");
  redirect("/sign-in");
}
