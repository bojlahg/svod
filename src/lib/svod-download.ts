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
  // Truncate by code point, not UTF-16 unit: slicing a valid surrogate pair
  // (e.g. an emoji at the boundary) leaves a lone surrogate and makes
  // encodeURIComponent throw URIError. The ASCII fallback below stays safe
  // (ASCII chars are single units).
  const clean =
    Array.from((title || fallbackId).replace(/["\r\n]+/g, "").trim()).slice(0, 80).join("") ||
    fallbackId;
  const ascii = clean.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 60) || `note-${fallbackId.slice(0, 8)}`;
  const asciiName = `${ascii}.md`;
  const header = `attachment; filename="${asciiName}"; filename*=UTF-8''${pctEncodeUtf8(`${clean}.md`)}`;
  return { asciiName, header };
}
