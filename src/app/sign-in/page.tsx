import { translator } from "@/lib/t";
import { redirect } from "next/navigation";
import SignInForm from "./SignInForm";
import { env } from "@/lib/env";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await translator();
  return { title: t("Sign in — mozg") };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Somebody already signed in has no business on the form, and showing it to
  // them is how "why am I logged out?" starts — the form looks like proof that
  // they are. Send them where they were going instead. Only relative paths: a
  // `next` pointing off-site would make this an open redirect.
  const user = await currentUser();
  if (user) {
    const { next } = await searchParams;
    redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/brains");
  }

  // Reading this on the server keeps the decision in one place: the button is
  // shown only when the provider is actually configured, so it can never be a
  // button that leads to an error page.
  const githubEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

  return <SignInForm githubEnabled={githubEnabled} googleEnabled={googleEnabled} signUpEnabled={false} />;
}
