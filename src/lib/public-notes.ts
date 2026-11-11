import { one, query } from "@/db";
import type { Brain } from "@/db/types";

/**
 * The reading surface for brains that cost nothing.
 *
 * 116,587 notes sit in 131 free public brains — 85% of everything the
 * catalogue holds — and until now none of it was published anywhere. A brain's
 * page shows fourteen note TITLES out of some nine hundred, so the entire
 * indexable surface of the site was 184 pages of description. robots.txt even
 * carried `Disallow: /b/*&#47;notes` for a route that did not exist.
 *
 * The unit is the category, not the note. A note is often two sentences —
 * 116k pages of those is a thin-content farm, and search engines are right to
 * treat it as one. Grouped by category the same corpus becomes 5,602 pages,
 * 3,281 of them holding five notes or more: coherent, specific, and exactly
 * the shape of the question somebody types.
 *
 * Nothing paid is ever exposed here. The test is gateFor() — the same one the
 * paywall uses — so a free child of a paid family stays shut, and there is no
 * second definition of "free" to drift from the first.
 */

/** Below this a category is published but kept out of the index. */
export const THIN_CATEGORY = 5;

/**
 * Notes on one page.
 *
 * Categories are not evenly sized: 2,855 hold between five and sixty notes,
 * but 76 hold more than two hundred and the largest is 1,056 — which rendered
 * as a single page of 49,188 words. That is slow to load, truncated by every
 * crawler that meets it, and useless to a reader looking for one answer. Sixty
 * is about four thousand words, which is a long article rather than a book.
 */
export const PER_PAGE = 60;

export interface PublicCategory {
  category: string;
  notes: number;
}

/** SVOD stage 2: open only to signed-in callers who may read the base. */
export async function openBrain(handle: string, slug: string): Promise<Brain | null> {
  const { currentUser } = await import("@/lib/session");
  const { brainAccessByHandleSlug } = await import("@/lib/svod-access");
  const user = await currentUser();
  if (!user) return null;
  const found = await brainAccessByHandleSlug(handle, slug, user.id);
  if (!found?.canRead) return null;
  return found.brain;
}

export async function categoriesOf(brainId: string): Promise<PublicCategory[]> {
  return query<PublicCategory>(
    `select category, count(*)::int as notes
       from notes
      where brain_id = $1 and status = 'active' and category is not null
      group by category
      order by count(*) desc, category`,
    [brainId],
  );
}

export interface PublicNote {
  id: string;
  title: string;
  body: string;
}

export async function notesIn(
  brainId: string,
  category: string,
  page = 1,
): Promise<{ notes: PublicNote[]; total: number; pages: number }> {
  const { rows } = await countAndPage(brainId, category, page);
  return rows;
}

async function countAndPage(brainId: string, category: string, page: number) {
  const total = await one<{ n: number }>(
    `select count(*)::int as n from notes
      where brain_id = $1 and status = 'active' and category = $2`,
    [brainId, category],
  );
  const pages = Math.max(1, Math.ceil(total.n / PER_PAGE));
  const safe = Math.min(Math.max(1, page), pages);
  const notes = await query<PublicNote>(
    `select id::text, title, body
       from notes
      where brain_id = $1 and status = 'active' and category = $2
      order by weight desc, created_at
      limit ${PER_PAGE} offset $3`,
    [brainId, category, (safe - 1) * PER_PAGE],
  );
  return { rows: { notes, total: total.n, pages } };
}

/**
 * Every category page worth putting in the sitemap, across every open brain.
 *
 * Thin ones are deliberately absent: they still render for a person who
 * follows a link, and they carry noindex, but asking a crawler to spend its
 * budget on a page holding two notes is how the substantial 3,281 get seen
 * less.
 */
export async function sitemapCategories(limit = 20_000): Promise<
  { handle: string; slug: string; category: string; updated: Date }[]
> {
  return query(
    `select u.handle, b.slug, n.category, max(n.created_at) as updated
       from notes n
       join brains b on b.id = n.brain_id
       join "user" u on u.id = b.owner_id
      where b.visibility = 'public' and b.price_cents = 0
        and n.status = 'active' and n.category is not null
        and u.handle is not null
        -- A free child of a PAID family is not free: the parent's price
        -- covers it, which is exactly what openBrain's gateFor() decides.
        and not exists (select 1 from brains p
                         where p.id = b.parent_id and p.price_cents > 0)
      group by u.handle, b.slug, n.category
     having count(*) >= ${THIN_CATEGORY}
      order by count(*) desc
      limit $1`,
    [limit],
  );
}

export interface OpenChild {
  handle: string;
  slug: string;
  title: string;
  notes: number;
}

/**
 * The readable children of an umbrella brain.
 *
 * react, nuxt, opentelemetry and the tf-aws family hold nothing themselves —
 * their material lives one level down, which is why their exam and their
 * search both run family-wide. Their notes index answered 404 until this:
 * technically true of their own rows, and wrong about the brain, since a
 * reader following the link wants the family's subjects.
 */
export async function openChildren(parentId: string): Promise<OpenChild[]> {
  return query<OpenChild>(
    `select u.handle, c.slug, c.title,
            (select count(*)::int from notes n
              where n.brain_id = c.id and n.status = 'active') as notes
       from brains c join "user" u on u.id = c.owner_id
      where c.parent_id = $1 and c.visibility = 'public' and c.price_cents = 0
        and u.handle is not null
      order by 4 desc`,
    [parentId],
  );
}

/**
 * Every brain whose notes index is actually open — the sitemap's own list.
 *
 * Derived from the category query rather than from "all public brains", which
 * is the bug this replaces: 165 index URLs were published and 30-odd of them
 * answered 404, because paid brains and empty umbrellas were in the list. A
 * sitemap that offers a crawler dead links spends its budget on nothing and
 * teaches it to trust the file less.
 */
export async function sitemapNoteIndexes(): Promise<
  { handle: string; slug: string; updated: Date }[]
> {
  return query(
    `select u.handle, b.slug, max(n.created_at) as updated
       from notes n
       join brains b on b.id = n.brain_id
       join "user" u on u.id = b.owner_id
      where b.visibility = 'public' and b.price_cents = 0
        and n.status = 'active' and n.category is not null
        and u.handle is not null
        and not exists (select 1 from brains p
                         where p.id = b.parent_id and p.price_cents > 0)
      group by u.handle, b.slug
     union
     select u.handle, p.slug, max(n.created_at) as updated
       from notes n
       join brains c on c.id = n.brain_id
       join brains p on p.id = c.parent_id
       join "user" u on u.id = p.owner_id
      where p.visibility = 'public' and p.price_cents = 0
        and c.visibility = 'public' and c.price_cents = 0
        and n.status = 'active' and u.handle is not null
      group by u.handle, p.slug`,
  );
}
