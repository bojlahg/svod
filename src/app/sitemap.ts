import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

/** SVOD stage 2: no indexable public surface — the sitemap does not exist. */
export default async function sitemap(): Promise<never> {
  notFound();
}
