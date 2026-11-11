/**
 * Exact-download filename: ByteString-safe headers with a Unicode title.
 *
 * Fetch/Next Response headers require ByteString, so a Cyrillic title cannot
 * ride in `filename="..."`. Use an ASCII fallback there plus RFC 5987/6266
 * `filename*` (percent-encoded UTF-8, including ' ( ) *).
 */

function pctEncodeUtf8(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).toUpperCase();
    return `%${hex.length === 1 ? `0${hex}` : hex}`;
  });
}

export function downloadFileParts(
  title: string,
  fallbackId: string,
): { asciiName: string; header: string } {
  const clean = (title || fallbackId).replace(/["\r\n]+/g, "").trim().slice(0, 80) || fallbackId;
  const ascii = clean.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 60) || `note-${fallbackId.slice(0, 8)}`;
  const asciiName = `${ascii}.md`;
  const header = `attachment; filename="${asciiName}"; filename*=UTF-8''${pctEncodeUtf8(`${clean}.md`)}`;
  return { asciiName, header };
}
