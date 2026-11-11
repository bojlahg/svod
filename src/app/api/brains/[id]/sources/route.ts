import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { brainAccessById } from "@/lib/svod-access";

/**
 * SVOD stage 3: legacy upload retired. The old path accepted screenshots/PDFs
 * and queued paid extraction; the workspace now takes Markdown notes only
 * (editor or .md upload via svod-actions). Direct invocation is denied after
 * the same role check so a forged ID learns nothing new. Reading authorized
 * legacy attachments stays via /api/storage.
 */

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser(req);
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const { id } = await ctx.params;
  // Editors and above may upload; readers cannot. Unknown and ungranted are
  // the same 404 so a forged ID reveals nothing.
  const access = await brainAccessById(id, user.id);
  if (!access?.canEdit) {
    return NextResponse.json({ error: "Brain not found." }, { status: 404 });
  }

  return NextResponse.json(
    { error: "Retired: upload a .md file from the workspace instead." },
    { status: 410 },
  );
}
