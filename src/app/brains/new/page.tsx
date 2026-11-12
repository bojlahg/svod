import { translator } from "@/lib/t";
import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { currentUser } from "@/lib/session";
import { possibleParents } from "@/lib/families";
import NewBrainForm from "./NewBrainForm";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await translator();
  return { title: t("New brain — svod") };
}

export default async function NewBrainPage() {
  const t = await translator();

  const user = await currentUser();
  if (!user) redirect("/sign-in?next=/brains/new");

  const parents = await possibleParents(user.id);

  return (
    <AppShell active="/brains/new" eyebrow={t("One job per brain")} title={t("New brain")} narrow>
      <NewBrainForm parents={parents.map((p) => ({ id: p.id, title: p.title }))} />
    </AppShell>
  );
}
