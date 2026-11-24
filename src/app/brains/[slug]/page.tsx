import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { translator } from "@/lib/t";
import { fill } from "@/lib/markup";
import { query } from "@/db";
import type { Note } from "@/db/types";
import { currentUser } from "@/lib/session";
import {
  listFolders,
  buildFolderTree,
  folderPath,
  expandedForNote,
  firstParam,
  isUuid,
  type FolderNode,
} from "@/lib/svod-folders";
import { listAccessibleBrains } from "@/lib/svod-access";
import { getPendingSvodNote, getSvodNote, searchSvodNotes } from "@/lib/svod-notes";
import { getSvodIndexStatus } from "@/lib/svod-index";
import SvodMarkdown from "@/components/SvodMarkdown";
import SvodEditor from "./svod-editor";
import SvodUpload from "./svod-upload";
import SvodBasePicker from "./svod-base-picker";
import SvodMobileBar from "./svod-mobilebar";
import SvodNavGuard from "./svod-nav-guard";
import SvodNoteMenu from "./svod-note-menu";
import {
  SvodAutoIndexForm,
  SvodFolderCreateForm,
  SvodFolderRenameForm,
  SvodIndexRefreshForm,
} from "./svod-forms";
import { rejectNote } from "./review-actions";
import ProposalReviewForm from "./proposal-review-form";
import { SvodImportForm } from "./svod-transfer";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await currentUser();
  if (!user) return { title: "svod" };
  const { workspaceBrain } = await import("@/lib/svod-access");
  const found = await workspaceBrain(slug, user.id);
  if (!found?.canRead) return { title: "svod" };
  return { title: `${found.brain.title} — svod` };
}

interface SearchParams {
  note?: string | string[];
  folder?: string | string[];
  q?: string | string[];
  edit?: string | string[];
  new?: string | string[];
  pendingPage?: string | string[];
  view?: string | string[];
}

export default async function SvodWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const t = await translator();
  const { slug } = await params;
  const raw = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const { workspaceBrain } = await import("@/lib/svod-access");
  const access = await workspaceBrain(slug, user.id);
  if (!access?.canRead) notFound();
  const brain = access.brain;
  const canEdit = access.canEdit;
  const canReview = access.canReview;

  const viewRaw = firstParam(raw.view).trim().toLowerCase();
  const view: "notes" | "review" | "manage" =
    viewRaw === "review" ? "review" : viewRaw === "manage" ? "manage" : "notes";
  if (view === "review" && !canReview) notFound();
  // Manage is readable by all canRead (export API is canRead): mutations and
  // review-gated rows are gated inside the view, never by a whole-view 404.

  const q = firstParam(raw.q).trim().slice(0, 200);
  const selectedRaw = firstParam(raw.note).trim();
  const selectedId = selectedRaw || null;
  if (selectedId && !isUuid(selectedId)) notFound();
  const editing = firstParam(raw.edit) === "1";
  const creating = firstParam(raw.new) === "1";
  const folderFocusRaw = firstParam(raw.folder).trim();
  const folderFocus = folderFocusRaw || null;
  const pendingPageRaw = Number(firstParam(raw.pendingPage));
  // Clamp to a safe supported range BEFORE multiplying for SQL OFFSET:
  // firstParam takes the first repeated value; non-numeric/negative/overflow
  // fall back to 0 and large values clamp so OFFSET stays a safe integer.
  const MAX_PENDING_PAGE = 5000;
  const pendingPage =
    Number.isInteger(pendingPageRaw) && pendingPageRaw >= 0
      ? Math.min(pendingPageRaw, MAX_PENDING_PAGE)
      : 0;
  const PENDING_PAGE_SIZE = 20;

  const [bases, folders] = await Promise.all([
    listAccessibleBrains(user.id),
    listFolders(brain.id),
  ]);
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const tree = buildFolderTree(folders);
  const validFolderFocus = folderFocus && isUuid(folderFocus) && folderById.has(folderFocus) ? folderFocus : null;

  const activeNotes = await query<{ id: string; title: string; folder_id: string | null }>(
    `select id, title, folder_id from notes
      where brain_id = $1 and status = 'active'
      order by title`,
    [brain.id],
  );
  const notesByFolder = new Map<string | null, { id: string; title: string; folder_id: string | null }[]>();
  for (const n of activeNotes) {
    const key = n.folder_id ?? null;
    notesByFolder.set(key, [...(notesByFolder.get(key) ?? []), n]);
  }

  const [pendingCountRow, indexStatus] = await Promise.all([
    query<{ n: number }>(
      `select count(*)::int as n from notes where brain_id = $1 and status = 'pending'`,
      [brain.id],
    ).then((r) => r[0]?.n ?? 0),
    getSvodIndexStatus(brain.id).catch(() => ({
      autoIndex: false,
      pendingNotes: 0,
      pendingChunks: 0,
      errorChunks: 0,
      lastError: null as string | null,
    })),
  ]);

  // Embed fingerprint for the management diagnostics (read-only; never blocks
  // the page). While the model is still loading Markdown stays readable.
  let embedNote: string | null = null;
  let embedReady = false;
  try {
    const { getSvodEmbedState } = await import("@/lib/embed");
    const st = await getSvodEmbedState();
    embedReady = st.usable;
    if (!st.usable) embedNote = st.reason;
  } catch {
    embedNote = "embed service unavailable";
  }

  const pendingNotes = canReview
    ? await query<{
        id: string;
        title: string;
        body: string;
        created_at: Date;
        revision: number;
        target_note_id: string | null;
        target_revision: number | null;
        token_id: string | null;
        proposed_by: string | null;
        token_prefix: string | null;
        token_name: string | null;
      }>(
        `select n.id, n.title, n.body, n.created_at, n.revision, n.target_note_id, n.target_revision,
                n.token_id, n.proposed_by,
                tok.prefix as token_prefix, tok.name as token_name
           from notes n
           left join mcp_tokens tok on tok.id = n.token_id
          where n.brain_id = $1 and n.status = 'pending'
          order by n.created_at desc limit 20 offset $2`,
        [brain.id, pendingPage * PENDING_PAGE_SIZE],
      )
    : [];

  let selected: Note | null = null;
  if (selectedId) {
    // Normal reading is active-only at the boundary; pending is reviewer-only.
    selected = await getSvodNote(brain.id, selectedId);
    if (!selected && canReview) {
      selected = await getPendingSvodNote(brain.id, selectedId);
    }
    if (!selected) notFound();
    if (selected.status === "pending" && !canReview) notFound();
    // Stable pending-note links (?note=<pendingID>) default to review for
    // authorized reviewers when no explicit view was given; active links pass
    // through unchanged and strangers still 404 above.
    if (selected.status === "pending" && canReview && view === "notes") {
      const params = new URLSearchParams();
      params.set("view", "review");
      params.set("note", selected.id);
      if (q) params.set("q", q);
      redirect(`/brains/${brain.id}?${params.toString()}`);
    }
  }

  const searchHits = q ? await searchSvodNotes(brain.id, q, 20) : [];

  const expanded = new Set<string>();
  if (selected?.folder_id) {
    for (const id of expandedForNote(folders, selected.folder_id)) expanded.add(id);
  }
  if (validFolderFocus) {
    let cur: string | null = validFolderFocus;
    let guard = 0;
    while (cur && guard++ < 100) {
      expanded.add(cur);
      cur = folderById.get(cur)?.parent_id ?? null;
    }
  }
  for (const h of searchHits) {
    if (h.folder_id) for (const id of expandedForNote(folders, h.folder_id)) expanded.add(id);
  }

  const selectedPath = selected ? folderPath(folders, selected.folder_id) : "";
  const focusPath = validFolderFocus
    ? folderPath(folders, validFolderFocus)
    : "";
  const baseHref = `/brains/${brain.id}`;

  const noteLink = (id: string) =>
    q ? `${baseHref}?note=${id}&q=${encodeURIComponent(q)}` : `${baseHref}?note=${id}`;

  const legacySources = await query<{
    id: string;
    original_name: string | null;
    mime: string | null;
    bytes: number | null;
    storage_key: string | null;
  }>(
    `select id, original_name, mime, bytes, storage_key from sources
      where brain_id = $1 order by created_at desc limit 30`,
    [brain.id],
  );

  const folderOptions = folders.map((f) => ({ id: f.id, name: f.name, path: folderPath(folders, f.parent_id) }));
  const formParents = folderOptions.map((f) => ({
    id: f.id,
    label: f.path ? `${f.path} / ${f.name}` : f.name,
  }));
  const moveFolders = folderOptions.map((f) => ({
    id: f.id,
    label: f.path ? `${f.path} / ${f.name}` : f.name,
  }));

  // Edit-proposal targets (original/current accepted versions) for reviewer diff.
  // Scoped to THIS proposal base (never expose a target that moved out of scope).
  const targetIds = [...new Set(pendingNotes.map((p) => p.target_note_id).filter((x): x is string => Boolean(x)))];
  const targets = targetIds.length
    ? await query<{ id: string; title: string; body: string; folder_id: string | null; revision: number }>(
        `select id, title, body, folder_id, revision from notes
          where id = any($1::uuid[]) and brain_id = $2 and status = 'active'`,
        [targetIds, brain.id],
      )
    : [];
  const targetById = new Map(targets.map((x) => [x.id, x]));

  // Selected proposal's original, loaded by scoped UUID independently of the
  // first queue page (older proposals beyond LIMIT 20 still review fully).
  let selectedTarget: { id: string; title: string; body: string; revision: number } | null = null;
  let selectedProposalMeta: { token_prefix: string | null; token_name: string | null } | null = null;
  if (selected && selected.status === "pending" && canReview) {
    if (selected.target_note_id) {
      selectedTarget =
        (await query<{ id: string; title: string; body: string; revision: number }>(
          `select id, title, body, revision from notes
            where id = $1 and brain_id = $2 and status = 'active'`,
          [selected.target_note_id, selected.brain_id],
        ))[0] ?? null;
    }
    const meta = await query<{ token_prefix: string | null; token_name: string | null }>(
      `select tok.prefix as token_prefix, tok.name as token_name
         from notes n left join mcp_tokens tok on tok.id = n.token_id
        where n.id = $1`,
      [selected.id],
    );
    selectedProposalMeta = meta[0] ?? { token_prefix: null, token_name: null };
  }

  // Transfer attribution for active notes accepted from proposals (same-base
  // edits and moved edits): title/body unchanged, attribution via history link.
  let acceptedFrom: {
    id: string;
    brain_id: string;
    brain_title: string | null;
    target_note_id: string | null;
    token_prefix: string | null;
    reason: string | null;
  } | null = null;
  if (selected && selected.status === "active") {
    const rows = await query<{
      id: string;
      brain_id: string;
      brain_title: string | null;
      target_note_id: string | null;
      token_prefix: string | null;
      reason: string | null;
    }>(
      `select p.id, p.brain_id, b.title as brain_title, p.target_note_id,
              tok.prefix as token_prefix, p.superseded_reason as reason
         from notes p
         left join brains b on b.id = p.brain_id
         left join mcp_tokens tok on tok.id = p.token_id
        where p.superseded_by = $1 and p.status = 'superseded'
        order by p.created_at desc limit 1`,
      [selected.id],
    );
    acceptedFrom = rows[0] ?? null;
  }

  // Destination candidates for reviewer moves: bases they can review on both ends.
  const reviewableBases = canReview ? bases.filter(() => true).slice(0, 30) : [];
  // Folders per destination base for the visible folder selector (cross-base
  // moves default to destination root; stale source folders are reset).
  const foldersByBrain: Record<string, { id: string; label: string }[]> = {
    [brain.id]: moveFolders,
  };
  if (canReview && reviewableBases.length > 1) {
    const others = reviewableBases.filter((b) => b.id !== brain.id).slice(0, 10);
    const fetched = await Promise.all(
      others.map(async (b) => {
        const fs = await listFolders(b.id);
        return [b.id, fs.map((f) => ({ id: f.id, label: folderPath(fs, f.parent_id) ? `${folderPath(fs, f.parent_id)} / ${f.name}` : f.name }))] as const;
      }),
    );
    for (const [bid, list] of fetched) foldersByBrain[bid] = list;
  }

  const showEditor =
    view === "notes" &&
    ((creating && canEdit) ||
      (editing && canEdit && selected?.status === "active"));
  const indexHasError =
    indexStatus.errorChunks > 0 || Boolean(indexStatus.lastError);
  const crumbs = selected
    ? `${brain.title} / ${selectedPath || t("Base root")} / ${selected.title}`
    : creating
      ? `${brain.title} / ${t("New note")}`
      : view === "review"
        ? `${brain.title} / ${t("Proposals")}`
        : view === "manage"
          ? `${brain.title} / ${t("Base management")}`
          : `${brain.title} / ${focusPath || t("Notes")}`;

  return (
    <div className="svod-ws" data-focus="off" data-nav="open">
      <SvodNavGuard />
      <SvodMobileBar baseTitle={brain.title} />
      <a href="#svod-main" className="svod-ws-skip">
        {t("Skip to note")}
      </a>
      <aside id="svod-nav" className="svod-ws-side" aria-label={t("Base navigation")}>
        <div className="svod-ws-brand">
          <Link href="/brains" className="svod-ws-wordmark">
            {t("svod")}
          </Link>
        </div>

        <div className="svod-ws-base">
          <SvodBasePicker
            bases={bases.map((b) => ({ id: b.id, title: b.title, member_role: b.member_role }))}
            currentId={brain.id}
          />
          <Link
            href={`${baseHref}?view=manage${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className="svod-ws-iconbtn"
            aria-label={t("Base management")}
            title={t("Base management")}
            data-active={view === "manage" ? "true" : undefined}
          >
            {"⚙"}
          </Link>
        </div>

        <form
          method="get"
          action={baseHref}
          role="search"
          className="svod-ws-search"
        >
          {selectedId ? <input type="hidden" name="note" value={selectedId} /> : null}
          <input
            name="q"
            defaultValue={q}
            placeholder={t("Search notes")}
            aria-label={t("Search notes")}
          />
          {q ? (
            <Link
              href={selectedId ? `${baseHref}?note=${selectedId}` : baseHref}
              aria-label={t("Clear search")}
              style={{ fontSize: ".8125rem" }}
            >
              {t("Clear")}
            </Link>
          ) : null}
        </form>

        {q ? (
          <section aria-label={t("Search results")} className="svod-ws-results">
            <p style={{ fontSize: ".75rem", color: "#a1aabc", margin: "0 0 .25rem" }}>
              {searchHits.length === 0
                ? t("Nothing matches that.")
                : `${searchHits.length} ${t("match(es)")}`}
            </p>
            {searchHits.map((h) => (
              <Link
                key={h.note_id}
                href={noteLink(h.note_id)}
                aria-current={selectedId === h.note_id ? "page" : undefined}
                className="svod-ws-hit"
                data-active={selectedId === h.note_id ? "true" : undefined}
              >
                <strong>{h.title}</strong>
                <span className="svod-ws-hitpath">
                  {folderPath(folders, h.folder_id) || t("Base root")}
                </span>
                <span className="svod-ws-hitexcerpt">{h.excerpt}</span>
              </Link>
            ))}
          </section>
        ) : null}

        <div className="svod-ws-sec">
          <span className="svod-ws-sec-title">
            {view === "review" ? t("Proposals") : t("Notes")}
          </span>
          {view === "notes" && canEdit && (
            <Link
              href={`${baseHref}?new=1${validFolderFocus ? `&folder=${validFolderFocus}` : ""}`}
              className="svod-ws-iconbtn"
              aria-label={t("New note")}
              title={t("New note")}
            >
              {"+"}
            </Link>
          )}
        </div>

        {view === "review" ? (
          <nav className="svod-ws-tree" aria-label={t("Proposal queue")}>
            <Link href={baseHref} className="svod-ws-note">
              {t("← Back to notes")}
            </Link>
            {pendingNotes.map((p) => {
              const target = p.target_note_id ? targetById.get(p.target_note_id) : null;
              const active = selectedId === p.id;
              return (
                <Link
                  key={p.id}
                  href={`${baseHref}?view=review&note=${p.id}${q ? `&q=${encodeURIComponent(q)}` : ""}${pendingPage ? `&pendingPage=${pendingPage}` : ""}`}
                  aria-current={active ? "page" : undefined}
                  className="svod-ws-note"
                  data-active={active ? "true" : undefined}
                >
                  {p.title}
                  <span className="svod-ws-hitpath" style={{ display: "block" }}>
                    {target
                      ? `${t("edit of")} ${target.title.slice(0, 40)} · `
                      : `${t("new note")} · `}
                    {t("rev")} {p.revision}
                    {p.token_prefix ? ` · ${p.token_prefix}…` : ""}
                  </span>
                </Link>
              );
            })}
            {pendingCountRow > PENDING_PAGE_SIZE && (
              <div style={{ display: "flex", gap: ".4rem", marginTop: ".4rem", flexWrap: "wrap" }}>
                {pendingPage > 0 && (
                  <Link
                    className="svod-ws-btn"
                    href={`${baseHref}?view=review&pendingPage=${pendingPage - 1}${selectedId ? `&note=${selectedId}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                  >
                    {t("Newer")}
                  </Link>
                )}
                {(pendingPage + 1) * PENDING_PAGE_SIZE < pendingCountRow && (
                  <Link
                    className="svod-ws-btn"
                    href={`${baseHref}?view=review&pendingPage=${pendingPage + 1}${selectedId ? `&note=${selectedId}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                  >
                    {t("Older")}
                  </Link>
                )}
              </div>
            )}
          </nav>
        ) : (
          <nav className="svod-ws-tree" aria-label={t("Folders and notes")}>
            <TreeNodes
              nodes={tree}
              notesByFolder={notesByFolder}
              expanded={expanded}
              selectedId={selectedId}
              baseHref={baseHref}
              q={q}
              canEdit={canEdit}
              t={t}
            />
            <div style={{ display: "grid", gap: ".1rem" }}>
              {(notesByFolder.get(null) ?? []).map((n) => (
                <Link
                  key={n.id}
                  href={noteLink(n.id)}
                  aria-current={selectedId === n.id ? "page" : undefined}
                  className="svod-ws-note"
                  data-active={selectedId === n.id ? "true" : undefined}
                >
                  {n.title}
                </Link>
              ))}
            </div>
            {canEdit && (
              <details className="svod-ws-newfolder" style={{ marginTop: ".4rem" }}>
                <summary style={{ cursor: "pointer" }} aria-label={t("New folder")}>
                  <span aria-hidden="true">{"+"}</span> {t("New folder")}
                </summary>
                <SvodFolderCreateForm
                  brainId={brain.id}
                  slug={brain.slug}
                  parents={formParents}
                  defaultParent={validFolderFocus ?? ""}
                />
              </details>
            )}
          </nav>
        )}

        {view !== "manage" && (
          <p className="svod-ws-indexline" data-error={indexHasError ? "true" : undefined}>
            <span>
              {t("Index")}: {indexStatus.pendingNotes} {t("notes")} ·{" "}
              {indexStatus.pendingChunks} {t("chunks")} · {indexStatus.errorChunks}{" "}
              {t("errors")}
            </span>
            <Link href={`${baseHref}?view=manage`}>{t("Details")}</Link>
          </p>
        )}

        <div className="svod-ws-foot">
          {canReview && (
            <Link
              href={`${baseHref}?view=review`}
              className="svod-ws-footlink"
              data-active={view === "review" ? "true" : undefined}
            >
              {t("Proposals")} <span className="svod-ws-count">{pendingCountRow}</span>
            </Link>
          )}
          <Link
            href={`${baseHref}?view=manage`}
            className="svod-ws-footlink"
            data-active={view === "manage" ? "true" : undefined}
          >
            {t("Base management")}
          </Link>
          <Link href="/settings/tokens" className="svod-ws-footlink">
            {t("Agents and access")}
          </Link>
          <Link href="/settings" className="svod-ws-footlink">
            {t("Settings")}
          </Link>
        </div>
      </aside>

      <main id="svod-main" className="svod-ws-main" tabIndex={-1}>
        <header className="svod-ws-crumbs">
          <span className="svod-ws-path">{crumbs}</span>
          {view === "notes" && selected && (
            <div className="svod-ws-tabs" aria-label={t("Note mode")}>
              <Link
                href={noteLink(selected.id)}
                className="svod-ws-tab"
                aria-pressed={!editing ? "true" : "false"}
                data-active={!editing ? "true" : undefined}
              >
                {t("Reading")}
              </Link>
              {canEdit && selected.status === "active" && (
                <Link
                  href={`${noteLink(selected.id)}&edit=1`}
                  className="svod-ws-tab"
                  aria-pressed={editing ? "true" : "false"}
                  data-active={editing ? "true" : undefined}
                >
                  {t("Editor")}
                </Link>
              )}
            </div>
          )}
        </header>

        {view === "manage" ? (
          <section className="svod-ws-manage" aria-label={t("Base management")}>
            <div>
              <h1 style={{ fontSize: "1.375rem", margin: 0, fontWeight: 650 }}>{t("Base management")}</h1>
              <p className="svod-ws-meta">
                {brain.title} · <span className="svod-ws-techid">{brain.id.slice(0, 8)}</span> · {access.role ?? ""}
              </p>
            </div>

            <div className="svod-ws-card">
              <h2>{t("Search index")}</h2>
              {canEdit && (
                <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap", alignItems: "center" }}>
                  <SvodIndexRefreshForm brainId={brain.id} />
                  <SvodAutoIndexForm brainId={brain.id} initial={indexStatus.autoIndex} />
                </div>
              )}
              <div>
                <div className="svod-ws-row">
                  <span>{t("Notes awaiting index")}</span>
                  <span>{indexStatus.pendingNotes}</span>
                </div>
                <div className="svod-ws-row">
                  <span>{t("Chunks in progress")}</span>
                  <span>{indexStatus.pendingChunks}</span>
                </div>
                <div className="svod-ws-row">
                  <span>{t("Index errors")}</span>
                  <span>{indexStatus.errorChunks}</span>
                </div>
                <div className="svod-ws-row">
                  <span>{t("Automatic indexing")}</span>
                  <span>{indexStatus.autoIndex ? t("On") : t("Off")}</span>
                </div>
                <div className="svod-ws-row">
                  <span>{t("Embedding model")}</span>
                  <span>{embedReady ? t("Ready") : (embedNote ?? t("Loading"))}</span>
                </div>
              </div>
              {indexStatus.lastError ? (
                <p role="alert" className="svod-ws-error" style={{ margin: 0 }}>
                  {t("Last index error")}: {indexStatus.lastError.slice(0, 300)}
                </p>
              ) : null}
              {!embedReady && embedNote ? (
                <p className="svod-ws-error" style={{ margin: 0 }}>
                  {t("Semantic search unavailable")}: {embedNote.slice(0, 200)}
                </p>
              ) : null}
            </div>

            {canEdit && (
              <div className="svod-ws-card">
                <h2>{t("Import")}</h2>
                <SvodImportForm brainId={brain.id} />
              </div>
            )}

            {canEdit && (
              <div className="svod-ws-card">
                <h2>{t("Upload a Markdown note")}</h2>
                <SvodUpload brainId={brain.id} slug={brain.slug} folders={folderOptions} currentFolder={validFolderFocus} />
              </div>
            )}

            <div className="svod-ws-card">
              <h2>{t("Export")}</h2>
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                <a className="svod-ws-btn" href={`/api/brains/${brain.id}/svod-export?format=full`}>
                  {t("Export full archive")}
                </a>
                <a className="svod-ws-btn" href={`/api/brains/${brain.id}/svod-export?format=markdown`}>
                  {t("Export Markdown")}
                </a>
              </div>
            </div>

            <div className="svod-ws-card">
              <h2>{t("Details")}</h2>
              <div className="svod-ws-row">
                <span>{t("Active notes")}</span>
                <span>{activeNotes.length}</span>
              </div>
              {canReview && (
                <div className="svod-ws-row">
                  <span>{t("Pending review")}</span>
                  <span>{pendingCountRow}</span>
                </div>
              )}
              {legacySources.length > 0 ? (
                <div>
                  <p style={{ margin: ".4rem 0" }}>{t("Legacy attachments (read-only)")}</p>
                  <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "#a1aabc", fontSize: ".8125rem" }}>
                    {legacySources.map((s) =>
                      s.storage_key ? (
                        <li key={s.id}>
                          <a href={`/api/storage/${s.storage_key}`} style={{ color: "#a1aabc" }}>
                            {s.original_name ?? s.id.slice(0, 8)}
                          </a>
                        </li>
                      ) : (
                        <li key={s.id}>{s.original_name ?? s.id.slice(0, 8)}</li>
                      ),
                    )}
                  </ul>
                </div>
              ) : (
                <p style={{ margin: 0, color: "#a1aabc", fontSize: ".875rem" }}>
                  {t("No legacy attachments.")}
                </p>
              )}
              {access.canAdmin && (
                <Link className="svod-ws-btn" href={`/brains/${brain.id}/share`}>
                  {t("Members and sharing (owner)")}
                </Link>
              )}
            </div>
          </section>
        ) : view === "review" ? (
          <section className="svod-ws-review" aria-label={t("Proposal review")}>
            {selected && selected.status === "pending" ? (
              <article style={{ display: "grid", gap: "1rem" }}>
                <div>
                  <p className="svod-ws-meta" style={{ marginBottom: ".25rem" }}>
                    {t("Proposals")} / {selected.title}
                  </p>
                  <h1 style={{ fontSize: "1.375rem", margin: 0, fontWeight: 650 }}>{selected.title}</h1>
                  <p className="svod-ws-meta" style={{ margin: ".3rem 0 0" }}>
                    {selectedProposalMeta?.token_prefix
                      ? `${t("via token")} ${selectedProposalMeta.token_prefix}…`
                      : t("via web")}
                    {` · ${t("rev")} ${selected.revision}`}
                    {selected.target_note_id
                      ? ` · target ${selected.target_note_id.slice(0, 8)} · ${t("base revision")} ${selected.target_revision ?? "—"}`
                      : ` · ${t("new note")}`}
                  </p>
                </div>
                {selected.target_note_id ? (
                  selectedTarget ? (
                    <div className="svod-ws-diff">
                      <div className="svod-ws-pane" data-kind="current">
                        <div className="svod-ws-sectitle"><span>{t("Current version")}</span></div>
                        <p className="svod-ws-meta">
                          {selectedTarget.title} · {t("rev")} {selectedTarget.revision}
                        </p>
                        <SvodMarkdown body={selectedTarget.body} />
                        <details style={{ marginTop: ".5rem" }}>
                          <summary style={{ fontSize: ".8125rem", cursor: "pointer" }}>
                            {t("Show exact source")}
                          </summary>
                          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".75rem", fontFamily: "ui-monospace, Menlo, monospace" }}>{`${selectedTarget.title}\n\n${selectedTarget.body}`}</pre>
                        </details>
                      </div>
                      <div className="svod-ws-pane" data-kind="proposed">
                        <div className="svod-ws-sectitle"><span>{t("Proposed version")}</span></div>
                        <SvodMarkdown body={selected.body} />
                        <details style={{ marginTop: ".5rem" }}>
                          <summary style={{ fontSize: ".8125rem", cursor: "pointer" }}>
                            {t("Show exact proposal")}
                          </summary>
                          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".75rem", fontFamily: "ui-monospace, Menlo, monospace" }}>{`${selected.title}\n\n${selected.body}`}</pre>
                        </details>
                      </div>
                    </div>
                  ) : (
                    <p role="alert" className="svod-ws-error">
                      {t("The original note is no longer available in this base.")}
                    </p>
                  )
                ) : (
                  <div className="svod-ws-pane" data-kind="proposed">
                    <div className="svod-ws-sectitle"><span>{t("Proposed new note")}</span></div>
                    <SvodMarkdown body={selected.body} />
                  </div>
                )}
                <ProposalReviewForm
                  key={selected.id}
                  proposalId={selected.id}
                  slug={brain.slug}
                  initialTitle={selected.title}
                  initialBody={selected.body}
                  foldersByBrain={foldersByBrain}
                  bases={reviewableBases.map((b) => ({ id: b.id, title: b.title }))}
                  currentBrainId={brain.id}
                  proposalRevision={selected.revision}
                  targetRevision={selected.target_note_id ? (selectedTarget?.revision ?? selected.target_revision) : null}
                  expectedSourceBrainId={selected.brain_id}
                />
                <div style={{ display: "flex", gap: ".4rem" }}>
                  <form action={rejectNote}>
                    <input type="hidden" name="id" value={selected.id} />
                    <input type="hidden" name="slug" value={brain.slug} />
                    <button className="svod-ws-btn" type="submit">
                      {t("Reject (keeps content)")}
                    </button>
                  </form>
                </div>
              </article>
            ) : (
              <div style={{ maxWidth: "40rem" }}>
                <h1 style={{ fontSize: "1.375rem", fontWeight: 650 }}>{t("Proposals")}</h1>
                <p style={{ color: "#a1aabc" }}>
                  {pendingCountRow === 0
                    ? t("Nothing awaiting review.")
                    : t("Select a proposal in the sidebar to compare versions.")}
                </p>
              </div>
            )}
          </section>
        ) : showEditor ? (
          creating ? (
            <SvodEditor
              key={`new-${validFolderFocus ?? "root"}`}
              brainId={brain.id}
              slug={brain.slug}
              baseHref={baseHref}
              folderId={validFolderFocus}
              folders={folderOptions}
              initialTitle=""
              initialBody=""
              folderLabel={focusPath || t("Base root")}
              mode="create"
            />
          ) : (
            selected && (
              <SvodEditor
                key={selected.id}
                brainId={brain.id}
                slug={brain.slug}
                baseHref={baseHref}
                noteId={selected.id}
                folderId={selected.folder_id}
                folders={folderOptions}
                initialTitle={selected.title}
                initialBody={selected.body}
                folderLabel={selectedPath || t("Base root")}
                mode="edit"
              />
            )
          )
        ) : selected ? (
          <article className="svod-ws-read">
            <p className="svod-ws-meta" style={{ marginBottom: ".4rem" }}>
              {selectedPath || t("Base root")} ·{" "}
              <span className="svod-ws-techid">{selected.id.slice(0, 8)}</span>
              {selected.status === "pending" ? ` · ${t("awaiting review — not searchable")}` : ""}
            </p>
            <h1>{selected.title}</h1>
            <SvodMarkdown body={selected.body} />
            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginTop: "1.4rem", alignItems: "center" }}>
              {canEdit && selected.status === "active" && (
                <Link className="svod-ws-btn svod-ws-btn-primary" href={`${noteLink(selected.id)}&edit=1`}>
                  {t("Edit")}
                </Link>
              )}
              {selected.status === "active" && (
                <SvodNoteMenu
                  brainId={brain.id}
                  slug={brain.slug}
                  baseHref={baseHref}
                  noteId={selected.id}
                  currentFolder={selected.folder_id}
                  folders={moveFolders}
                  canEdit={canEdit}
                />
              )}
            </div>
            {selected.status === "active" && acceptedFrom && (
              <p style={{ fontSize: ".8125rem", color: "#a1aabc", marginTop: "1rem" }}>
                {acceptedFrom.target_note_id
                  ? fill(t("Accepted from proposal <0/> (target <1/>)<2/>"), [
                      acceptedFrom.id.slice(0, 8),
                      acceptedFrom.target_note_id.slice(0, 8),
                      acceptedFrom.brain_id !== selected.brain_id
                        ? ` · ${t("moved from")} ${acceptedFrom.brain_title ?? acceptedFrom.brain_id.slice(0, 8)}`
                        : "",
                    ])
                  : fill(t("Accepted from proposal <0/>"), [acceptedFrom.id.slice(0, 8)])}
                {acceptedFrom.token_prefix ? ` · ${t("via token")} ${acceptedFrom.token_prefix}…` : ""}
              </p>
            )}
          </article>
        ) : (
          <div className="svod-ws-read">
            <h1 style={{ fontSize: "1.375rem" }}>{t("Notes")}</h1>
            <p style={{ color: "#a1aabc" }}>{t("Select a note on the left, or search above.")}</p>
            <p style={{ fontSize: ".8125rem", color: "#a1aabc" }}>
              {t("A link by stable note ID keeps working after the note moves between folders.")}
            </p>
            {canEdit && (
              <div style={{ marginTop: "1rem", display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                <Link className="svod-ws-btn svod-ws-btn-primary" href={`${baseHref}?new=1${validFolderFocus ? `&folder=${validFolderFocus}` : ""}`}>
                  {t("New note")}
                </Link>
                <Link className="svod-ws-btn" href={`${baseHref}?view=manage`}>
                  {t("Import or upload")}
                </Link>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function TreeNodes({
  nodes,
  notesByFolder,
  expanded,
  selectedId,
  baseHref,
  q,
  canEdit,
  t,
}: {
  nodes: FolderNode[];
  notesByFolder: Map<string | null, { id: string; title: string; folder_id: string | null }[]>;
  expanded: Set<string>;
  selectedId: string | null;
  baseHref: string;
  q: string;
  canEdit: boolean;
  t: (s: string) => string;
}) {
  if (!nodes.length) return null;
  const link = (id: string) => (q ? `${baseHref}?note=${id}&q=${encodeURIComponent(q)}` : `${baseHref}?note=${id}`);
  return (
    <div style={{ display: "grid", gap: ".15rem" }}>
      {nodes.map((n) => {
        const open = expanded.has(n.folder.id);
        const notes = notesByFolder.get(n.folder.id) ?? [];
        return (
          <details key={n.folder.id} open={open} className="svod-ws-folder">
            <summary>
              <Link
                href={`${baseHref}?folder=${n.folder.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className="svod-ws-folder-link"
                aria-label={`${n.folder.name}`}
              >
                {n.folder.name}
              </Link>
              <span className="svod-ws-count">{notes.length + n.children.length}</span>
            </summary>
            <div className="svod-ws-folder-body">
              {canEdit && (
                <details className="svod-ws-folder-actions">
                  <summary aria-label={t("Folder actions")}>
                    {t("Actions")}
                  </summary>
                  <SvodFolderRenameForm
                    brainId={n.folder.brain_id}
                    folderId={n.folder.id}
                    currentName={n.folder.name}
                  />
                </details>
              )}
              {notes.map((note) => (
                <Link
                  key={note.id}
                  href={link(note.id)}
                  aria-current={selectedId === note.id ? "page" : undefined}
                  className="svod-ws-note"
                  data-active={selectedId === note.id ? "true" : undefined}
                >
                  {note.title}
                </Link>
              ))}
              <TreeNodes
                nodes={n.children}
                notesByFolder={notesByFolder}
                expanded={expanded}
                selectedId={selectedId}
                baseHref={baseHref}
                q={q}
                canEdit={canEdit}
                t={t}
              />
            </div>
          </details>
        );
      })}
    </div>
  );
}
