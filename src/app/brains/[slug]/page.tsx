import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { translator } from "@/lib/t";
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
import SvodMarkdown from "@/components/SvodMarkdown";
import SvodEditor from "./svod-editor";
import SvodUpload from "./svod-upload";
import ConfirmForm from "@/components/ConfirmForm";
import { deleteSvodNoteAction } from "./svod-actions";
import {
  SvodBaseRenameForm,
  SvodFolderCreateForm,
  SvodFolderRenameForm,
  SvodNoteMoveForm,
} from "./svod-forms";
import { approveNote, rejectNote } from "./review-actions";

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

  const [pendingCountRow, indexingRow] = await Promise.all([
    query<{ n: number }>(
      `select count(*)::int as n from notes where brain_id = $1 and status = 'pending'`,
      [brain.id],
    ).then((r) => r[0]?.n ?? 0),
    query<{ n: number }>(
      `select count(*)::int as n from notes n
        where n.brain_id = $1 and n.status = 'active'
          and exists (select 1 from chunks c where c.note_id = n.id and c.embedding is null)`,
      [brain.id],
    ).then((r) => r[0]?.n ?? 0),
  ]);

  const pendingNotes = canReview
    ? await query<{ id: string; title: string; created_at: Date }>(
        `select id, title, created_at from notes
          where brain_id = $1 and status = 'pending'
          order by created_at desc limit 20`,
        [brain.id],
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
          {t("awaiting index")}: {indexingRow}
        </span>
      </div>

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

          {canReview && pendingNotes.length > 0 && (
            <section style={{ marginTop: "1rem" }} aria-label={t("Pending review")}>
              <p className="mono" style={{ fontSize: ".6875rem", color: "#9aa3af", margin: "0 0 .4rem" }}>
                {t("Pending review")} · {pendingCountRow}
              </p>
              <div style={{ display: "grid", gap: ".4rem" }}>
                {pendingNotes.map((p) => (
                  <div key={p.id} className="svod-pending">
                    <Link href={`${baseHref}?note=${p.id}`} className="svod-note-link">
                      {p.title}
                    </Link>
                    <div style={{ display: "flex", gap: ".4rem", marginTop: ".3rem" }}>
                      <form action={approveNote}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="slug" value={brain.slug} />
                        <button className="svod-btn-ghost" type="submit">
                          {t("Approve")}
                        </button>
                      </form>
                      <form action={rejectNote}>
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="slug" value={brain.slug} />
                        <button className="svod-btn-ghost" type="submit">
                          {t("Reject")}
                        </button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
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
                      <div style={{ display: "flex", gap: ".4rem" }}>
                        <form action={approveNote}>
                          <input type="hidden" name="id" value={selected.id} />
                          <input type="hidden" name="slug" value={brain.slug} />
                          <button className="svod-btn" type="submit">
                            {t("Approve")}
                          </button>
                        </form>
                        <form action={rejectNote}>
                          <input type="hidden" name="id" value={selected.id} />
                          <input type="hidden" name="slug" value={brain.slug} />
                          <button className="svod-btn-ghost" type="submit">
                            {t("Reject")}
                          </button>
                        </form>
                      </div>
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
