import { createHash } from "node:crypto";

/**
 * SVOD stage 5 section split.
 *
 * A Svod note is cut by ATX header lines (`#` … `######` at the start of a
 * line). The text before the first header is its own section. Slices are
 * exact substrings of the stored body, including the header line and the
 * line break the body really uses (LF, CRLF or CR) — the hash is over those
 * bytes, with no newline normalisation.
 *
 * This is deliberately NOT chunkText (src/lib/chunk.ts): that algorithm
 * overlaps windows by ~60 tokens, so editing one section rewrites the
 * neighbour's text and no vector survives. Sections are independent by
 * construction: reordering sections or editing a neighbour never changes
 * this section's hash.
 */

const ATX_RE = /^#{1,6}(?:\s|$)/;

function isHeaderLine(lineWithoutBreak: string): boolean {
  return ATX_RE.test(lineWithoutBreak);
}

/**
 * Split the stored body into exact-substring section slices.
 * Empty (whitespace-only) bodies yield no sections, like chunkText.
 */
export function splitSvodSections(body: string): string[] {
  if (!body.replace(/\s/g, "")) return [];
  // Keep every line break with its line so slices stay byte-exact.
  const lines: string[] = body.match(/.*?(?:\r\n|\n|\r|$)/gs) ?? [];
  // The regex above yields a trailing "" when body ends with a break;
  // drop the phantom so joins stay exact.
  const cleaned: string[] = [];
  for (const l of lines) {
    if (l === "") continue;
    cleaned.push(l);
  }
  if (!cleaned.length) return [];

  const sections: string[] = [];
  let current = "";
  let seenHeader = false;
  for (const rawLine of cleaned) {
    // Strip exactly one trailing break for the header test, keep bytes.
    const noBreak = rawLine.replace(/(\r\n|\n|\r)$/, "");
    const hasBreak = rawLine.length !== noBreak.length;
    // A line that is only a break (empty line) never starts a section.
    if (!noBreak && hasBreak) {
      current += rawLine;
      continue;
    }
    if (isHeaderLine(noBreak)) {
      if (!seenHeader) {
        // Text before the first header is its own section (may be empty
        // when the body starts with a header — then there is no preface).
        if (current) sections.push(current);
        current = rawLine;
        seenHeader = true;
      } else {
        sections.push(current);
        current = rawLine;
      }
    } else {
      current += rawLine;
    }
  }
  if (current) sections.push(current);
  // Body without any header: a single section holding the whole body.
  if (!seenHeader && sections.length === 0 && current) return [current];
  return sections;
}

/** Embed input of one section: the note title is part of the input. */
export function svodSectionInput(title: string, slice: string): string {
  return `${title}\n\n${slice}`;
}

/** Identity of an embed input: SHA-256 hex of the UTF-8 input string. */
export function svodInputHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface SvodSection {
  ordinal: number;
  slice: string;
  input: string;
  hash: string;
}

/** Sections with their inputs and hashes, in order. */
export function svodSectionsForNote(title: string, body: string): SvodSection[] {
  return splitSvodSections(body).map((slice, ordinal) => {
    const input = svodSectionInput(title, slice);
    return { ordinal, slice, input, hash: svodInputHash(input) };
  });
}
