import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * SVOD stage 2: public profiles are retired. There is no public catalogue
 * and no published list — signed-in users go to their workspace.
 */
export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  await params;
  const user = await currentUser();
  if (user) redirect("/brains");
  redirect("/sign-in");
}
