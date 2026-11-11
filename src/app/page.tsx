import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * SVOD stage 2: private application boundary. The marketing catalogue is
 * retired — signed-in users go to their workspace, everyone else to sign-in.
 */
export default async function Home() {
  const user = await currentUser();
  if (user) redirect("/brains");
  redirect("/sign-in");
}
