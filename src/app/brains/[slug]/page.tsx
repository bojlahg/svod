import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { translator } from "@/lib/t";
import { fill } from "@/lib/markup";
import { query } from "@/db";
import type { Note } from "@/db/types";
import { currentUser } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
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
import ConfirmForm from "@/components/ConfirmForm";
import { deleteSvodNoteAction } from "./svod-actions";
import {
  SvodAutoIndexForm,
  SvodBaseRenameForm,
  SvodFolderCreateForm,
  SvodFolderRenameForm,
  SvodIndexRefreshForm,
  SvodNoteMoveForm,
} from "./svod-forms";
import { rejectNote } from "./review-actions";
import ProposalReviewForm from "./proposal-review-form";

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
  const operator = isAdmin(user);

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

  // Embed fingerprint for the status line (read-only; never blocks the page).
  // While the model is still loading Markdown stays readable and editable.
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

  return (
    <div className="svod">
      <a href="#svod-reader" className="svod-skip">
        {t("Skip to note")}
      </a>
      <header className="svod-top">
        <div className="svod-top-left">
          <Link href="/brains" className="svod-crumb">
            {t("← Bases")}
          </Link>
          <h1 className="svod-title">{brain.title}</h1>
          <span className="svod-role">{access.role ?? ""}</span>
        </div>
        <nav className="svod-top-nav" aria-label={t("Workspace")}>
          {operator && <Link href="/admin/users">{t("People")}</Link>}
          <Link href="/settings/tokens">{t("Tokens")}</Link>
          {access.canAdmin && <Link href={`/brains/${brain.id}/share`}>{t("Manage base")}</Link>}
        </nav>
      </header>

      <div className="svod-status" role="status">
        <span>
          {t("active notes")}: {activeNotes.length}
        </span>
        <span>
          {t("pending review")}: {pendingCountRow}
        </span>
        <span>
          {t("awaiting index")}: {indexStatus.pendingNotes}
        </span>
        <span>
          {t("chunks in progress")}: {indexStatus.pendingChunks}
        </span>
        <span>
          {t("index errors")}: {indexStatus.errorChunks}
        </span>
        {indexStatus.lastError ? (
          <span>
            {t("last index error")}: {indexStatus.lastError.slice(0, 160)}
          </span>
        ) : null}
        {!embedReady ? (
          <span>
            {embedNote
              ? `${t("semantic search unavailable")}: ${embedNote.slice(0, 160)}`
              : t("embedding model is loading — reading and editing still work")}
          </span>
        ) : null}
      </div>

      {canEdit ? (
        <div className="svod-index-controls" style={{ display: "flex", gap: ".75rem", flexWrap: "wrap", alignItems: "center", marginBottom: ".6rem" }}>
          <SvodIndexRefreshForm brainId={brain.id} />
          <SvodAutoIndexForm brainId={brain.id} initial={indexStatus.autoIndex} />
        </div>
      ) : null}

      <div className="svod-searchrow">
        <form method="get" action={baseHref} role="search" style={{ display: "flex", gap: ".5rem", flex: 1, minWidth: 0 }}>
          {selectedId ? <input type="hidden" name="note" value={selectedId} /> : null}
          <input
            name="q"
            defaultValue={q}
            placeholder={t("Search notes — title and folder path in results")}
            aria-label={t("Search notes")}
            className="svod-input"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="svod-btn" type="submit">
            {t("Search")}
          </button>
          {q ? (
            <Link className="svod-btn-ghost" href={selectedId ? `${baseHref}?note=${selectedId}` : baseHref}>
              {t("Clear")}
            </Link>
          ) : null}
        </form>
        {canEdit && (
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
            <Link className="svod-btn" href={`${baseHref}?new=1${validFolderFocus ? `&folder=${validFolderFocus}` : ""}`}>
              {t("+ Note")}
            </Link>
          </div>
        )}
      </div>

      {q ? (
        <section aria-label={t("Search results")} className="svod-results">
          <p className="mono" style={{ fontSize: ".75rem", color: "#9aa3af", margin: "0 0 .4rem" }}>
            {searchHits.length === 0 ? t("Nothing matches that.") : `${searchHits.length} ${t("match(es)")}`}
          </p>
          {searchHits.map((h) => (
            <Link
              key={h.note_id}
              href={noteLink(h.note_id)}
              aria-current={selectedId === h.note_id ? "true" : undefined}
              className="svod-result"
              data-active={selectedId === h.note_id ? "true" : undefined}
            >
              <strong>{h.title}</strong>
              <span className="svod-path">{folderPath(folders, h.folder_id) || t("Base root")}</span>
              <span className="svod-excerpt">{h.excerpt}</span>
            </Link>
          ))}
        </section>
      ) : null}

      <div className="svod-grid">
        <nav className="svod-tree" aria-label={t("Bases, folders and notes")}>
          {bases.map((b) =>
            b.id === brain.id ? (
              <details key={b.id} open className="svod-base">
                <summary className="svod-folder-sum">
                  <Link
                    href={`/brains/${b.id}`}
                    aria-current="page"
                    className="svod-folder-link"
                  >
                    <strong>{b.title}</strong> · {b.member_role}
                  </Link>
                </summary>
                <div className="svod-folder-body">
                  {canEdit && (
                    <SvodFolderCreateForm brainId={brain.id} slug={brain.slug} parents={[]} compact />
                  )}

                  {canEdit && <SvodBaseRenameForm brainId={brain.id} initialTitle={brain.title} />}

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
                  <div style={{ marginTop: ".6rem" }}>
                    {(notesByFolder.get(null) ?? []).map((n) => (
                      <div key={n.id} className="svod-note-row" data-active={selectedId === n.id ? "true" : undefined}>
                        <Link
                          href={noteLink(n.id)}
                          aria-current={selectedId === n.id ? "page" : undefined}
                          className="svod-note-link"
                        >
                          {n.title}
                        </Link>
                      </div>
                    ))}
                  </div>

                  {canEdit && (
                    <details className="svod-details">
                      <summary>{t("Add folder here")}</summary>
                      <SvodFolderCreateForm
                        brainId={brain.id}
                        slug={brain.slug}
                        parents={formParents}
                        defaultParent={validFolderFocus ?? ""}
                      />
                    </details>
                  )}
                </div>
              </details>
            ) : (
              <div key={b.id} className="svod-note-row">
                <Link href={`/brains/${b.id}`} className="svod-note-link">
                  {b.title} · {b.member_role}
                </Link>
              </div>
            ),
          )}

          {canReview && (pendingCountRow > 0) && (
            <section style={{ marginTop: "1rem" }} aria-label={t("Pending review")}>
              <p className="mono" style={{ fontSize: ".6875rem", color: "#9aa3af", margin: "0 0 .4rem" }}>
                {t("Pending review")} · {pendingCountRow}
                {pendingCountRow > PENDING_PAGE_SIZE ? ` · ${t("page")} ${pendingPage + 1}` : ""}
              </p>
              <div style={{ display: "grid", gap: ".3rem" }}>
                {pendingNotes.map((p) => {
                  const target = p.target_note_id ? targetById.get(p.target_note_id) : null;
                  const active = selectedId === p.id;
                  return (
                    <div key={p.id} className="svod-note-row" data-active={active ? "true" : undefined}>
                      <Link
                        href={`${baseHref}?note=${p.id}${q ? `&q=${encodeURIComponent(q)}` : ""}${pendingPage ? `&pendingPage=${pendingPage}` : ""}`}
                        aria-current={active ? "page" : undefined}
                        className="svod-note-link"
                      >
                        {p.title}
                      </Link>
                      <span className="mono" style={{ display: "block", fontSize: ".625rem", color: "#9aa3af" }}>
                        {target ? `${t("edit of")} ${target.title.slice(0, 40)} · ` : `${t("new note")} · `}
                        {t("rev")} {p.revision}
                        {p.token_prefix ? ` · ${p.token_prefix}…` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
              {pendingCountRow > PENDING_PAGE_SIZE && (
                <div style={{ display: "flex", gap: ".5rem", marginTop: ".5rem" }}>
                  {pendingPage > 0 && (
                    <Link
                      className="svod-btn-ghost"
                      href={`${baseHref}?pendingPage=${pendingPage - 1}${selectedId ? `&note=${selectedId}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                    >
                      {t("Newer")}
                    </Link>
                  )}
                  {(pendingPage + 1) * PENDING_PAGE_SIZE < pendingCountRow && (
                    <Link
                      className="svod-btn-ghost"
                      href={`${baseHref}?pendingPage=${pendingPage + 1}${selectedId ? `&note=${selectedId}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                    >
                      {t("Older")}
                    </Link>
                  )}
                </div>
              )}
            </section>
          )}
        </nav>

        <main id="svod-reader" className="svod-reader" tabIndex={-1} aria-label={t("Selected note")}>
          {creating && canEdit ? (
            <section>
              <h2 className="svod-h2">{t("New note")}</h2>
              <SvodEditor
                brainId={brain.id}
                slug={brain.slug}
                folderId={validFolderFocus}
                folders={folderOptions}
                initialTitle=""
                initialBody=""
                mode="create"
              />
            </section>
          ) : selected ? (
            <article>
              <p className="mono" style={{ fontSize: ".6875rem", color: "#6b7280", margin: "0 0 .3rem" }}>
                {selectedPath || t("Base root")} ·{" "}
                <Link href={noteLink(selected.id)} style={{ color: "#6b7280" }}>
                  {selected.id.slice(0, 8)}
                </Link>
                {selected.status === "pending" ? ` · ${t("awaiting review — not searchable")}` : ""}
              </p>
              <h2 className="svod-h2">{selected.title}</h2>
              {editing && canEdit && selected.status === "active" ? (
                <SvodEditor
                  brainId={brain.id}
                  slug={brain.slug}
                  noteId={selected.id}
                  folderId={selected.folder_id}
                  folders={folderOptions}
                  initialTitle={selected.title}
                  initialBody={selected.body}
                  mode="edit"
                />
              ) : (
                <>
                  <SvodMarkdown body={selected.body} />
                  <div className="svod-note-actions">
                    {selected.status === "active" && (
                      <a className="svod-btn-ghost" href={`/api/brains/${brain.id}/notes/${selected.id}/download`}>
                        {t("Download .md")}
                      </a>
                    )}
                    {canEdit && selected.status === "active" && (
                      <>
                        <Link className="svod-btn-ghost" href={`${noteLink(selected.id)}&edit=1`}>
                          {t("Edit")}
                        </Link>
                        <SvodNoteMoveForm
                          brainId={brain.id}
                          slug={brain.slug}
                          noteId={selected.id}
                          currentFolder={selected.folder_id}
                          folders={moveFolders}
                        />
                        <ConfirmForm
                          action={deleteSvodNoteAction}
                          message={t("Delete this note? This cannot be undone.")}
                        >
                          <input type="hidden" name="brainId" value={brain.id} />
                          <input type="hidden" name="slug" value={brain.slug} />
                          <input type="hidden" name="noteId" value={selected.id} />
                          <button className="svod-danger" type="submit">
                            {t("Delete")}
                          </button>
                        </ConfirmForm>
                      </>
                    )}
                    {canReview && selected.status === "pending" && (
                      <section style={{ marginTop: "1.5rem", display: "grid", gap: ".75rem" }} aria-label={t("Proposal review")}>
                        <p className="mono" style={{ fontSize: ".6875rem", color: "#9aa3af", margin: 0 }}>
                          {selectedProposalMeta?.token_prefix
                            ? `${t("via token")} ${selectedProposalMeta.token_prefix}…`
                            : t("via web")}
                          {` · ${t("rev")} ${selected.revision}`}
                          {selected.target_note_id
                            ? ` · target ${selected.target_note_id.slice(0, 8)} · ${t("base revision")} ${selected.target_revision ?? "—"}`
                            : ` · ${t("new note")}`}
                        </p>
                        {selected.target_note_id ? (
                          selectedTarget ? (
                            <div style={{ display: "grid", gap: ".6rem" }}>
                              <div>
                                <h3 className="svod-h3">{t("Current accepted (full)")}</h3>
                                <p className="mono" style={{ fontSize: ".6875rem", color: "#9aa3af" }}>
                                  {selectedTarget.title} · {t("rev")} {selectedTarget.revision}
                                </p>
                                <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid #2a2e35", borderRadius: 6, padding: ".6rem .8rem" }}>
                                  <SvodMarkdown body={selectedTarget.body} />
                                </div>
                                <details style={{ marginTop: ".4rem" }}>
                                  <summary className="mono" style={{ fontSize: ".6875rem", cursor: "pointer" }}>
                                    {t("Show exact source")}
                                  </summary>
                                  <pre style={{ whiteSpace: "pre-wrap", fontSize: ".75rem" }}>{`${selectedTarget.title}\n\n${selectedTarget.body}`}</pre>
                                </details>
                              </div>
                              <div>
                                <h3 className="svod-h3">{t("Proposed (full)")}</h3>
                                <div style={{ maxHeight: 320, overflow: "auto", border: "1px dashed #4b5563", borderRadius: 6, padding: ".6rem .8rem" }}>
                                  <SvodMarkdown body={selected.body} />
                                </div>
                                <details style={{ marginTop: ".4rem" }}>
                                  <summary className="mono" style={{ fontSize: ".6875rem", cursor: "pointer" }}>
                                    {t("Show exact proposal")}
                                  </summary>
                                  <pre style={{ whiteSpace: "pre-wrap", fontSize: ".75rem" }}>{`${selected.title}\n\n${selected.body}`}</pre>
                                </details>
                              </div>
                            </div>
                          ) : (
                            <p role="alert" className="mono" style={{ fontSize: ".75rem", color: "#f87171" }}>
                              {t("The original note is no longer available in this base.")}
                            </p>
                          )
                        ) : (
                          <div>
                            <h3 className="svod-h3">{t("Proposed new note (full)")}</h3>
                            <div style={{ maxHeight: 320, overflow: "auto", border: "1px dashed #4b5563", borderRadius: 6, padding: ".6rem .8rem" }}>
                              <SvodMarkdown body={selected.body} />
                            </div>
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
                            <button className="svod-btn-ghost" type="submit">
                              {t("Reject (keeps content)")}
                            </button>
                          </form>
                        </div>
                      </section>
                    )}
                    {selected.status === "active" && acceptedFrom && (
                      <p className="mono" style={{ fontSize: ".6875rem", color: "#9aa3af", marginTop: ".75rem" }}>
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
                  </div>
                </>
              )}
            </article>
          ) : (
            <div className="svod-empty">
              <p style={{ margin: "0 0 .5rem" }}>{t("Select a note on the left, or search above.")}</p>
              <p className="mono" style={{ fontSize: ".75rem", color: "#6b7280", margin: 0 }}>
                {t("A link by stable note ID keeps working after the note moves between folders.")}
              </p>
              {canEdit && (
                <div style={{ marginTop: "1rem", display: "grid", gap: "1rem" }}>
                  <SvodEditor
                    brainId={brain.id}
                    slug={brain.slug}
                    folderId={validFolderFocus}
                    folders={folderOptions}
                    initialTitle=""
                    initialBody=""
                    mode="create"
                  />
                  <section aria-label={t("Upload Markdown")}>
                    <h3 className="svod-h3">{t("Upload .md")}</h3>
                    <SvodUpload brainId={brain.id} slug={brain.slug} folders={folderOptions} currentFolder={validFolderFocus} />
                  </section>
                </div>
              )}
            </div>
          )}

          {canEdit && selected && !editing && (
            <section style={{ marginTop: "2rem" }} aria-label={t("Upload Markdown")}>
              <h3 className="svod-h3">{t("Upload .md")}</h3>
              <SvodUpload brainId={brain.id} slug={brain.slug} folders={folderOptions} currentFolder={selected.folder_id} />
            </section>
          )}

          {legacySources.length > 0 && (
            <section style={{ marginTop: "2rem" }} aria-label={t("Legacy attachments (read-only)")}>
              <h3 className="svod-h3">{t("Legacy attachments (read-only)")}</h3>
              <ul style={{ margin: ".4rem 0 0", paddingLeft: "1.1rem", color: "#9aa3af", fontSize: ".8125rem" }}>
                {legacySources.map((s) =>
                  s.storage_key ? (
                    <li key={s.id}>
                      <a href={`/api/storage/${s.storage_key}`} style={{ color: "#9aa3af" }}>
                        {s.original_name ?? s.id.slice(0, 8)}
                      </a>
                    </li>
                  ) : (
                    <li key={s.id}>{s.original_name ?? s.id.slice(0, 8)}</li>
                  ),
                )}
              </ul>
            </section>
          )}
        </main>
      </div>
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
          <details key={n.folder.id} open={open} className="svod-folder">
            <summary className="svod-folder-sum">
              <Link
                href={`${baseHref}?folder=${n.folder.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className="svod-folder-link"
                aria-label={`${n.folder.name}`}
              >
                {n.folder.name}
              </Link>
              <span className="svod-count">{notes.length + n.children.length}</span>
            </summary>
            <div className="svod-folder-body">
              {canEdit && (
                <div style={{ marginBottom: ".35rem" }}>
                  <SvodFolderRenameForm
                    brainId={n.folder.brain_id}
                    folderId={n.folder.id}
                    currentName={n.folder.name}
                  />
                </div>
              )}
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="svod-note-row"
                  data-active={selectedId === note.id ? "true" : undefined}
                >
                  <Link
                    href={link(note.id)}
                    aria-current={selectedId === note.id ? "page" : undefined}
                    className="svod-note-link"
                  >
                    {note.title}
                  </Link>
                </div>
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
