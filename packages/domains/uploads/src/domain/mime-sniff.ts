/**
 * Magic-byte MIME sniff for the formats agents' Read tool can open.
 * Returns the authoritative MIME or null if the bytes don't match any
 * supported format. Hand-rolled so we don't pull a runtime dependency
 * for well-known signatures.
 *
 * Image references:
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *   GIF   "GIF87a" | "GIF89a"
 *   WebP  "RIFF" .... "WEBP"
 * Doc references:
 *   PDF   "%PDF-"
 *   HTML  ascii starting with '<' (most reliable cross-source
 *         signature — accepts `<!doctype`, `<!DOCTYPE`, `<html`,
 *         `<HTML`, `<?xml`, BOM-prefixed variants)
 *
 * Caller supplies first ~32 bytes — enough for every supported sniff.
 * Text-like formats that don't carry magic bytes (text/plain,
 * text/markdown, text/csv, application/json) fall through to the
 * mimeHint-trust path in complete-upload.
 */
export type SniffedMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "text/html";

export function sniffImageMime(head: Uint8Array): SniffedMime | null {
  if (head.length >= 8 && matchAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (head.length >= 3 && matchAt(head, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (head.length >= 6 && (asAscii(head, 0, 6) === "GIF87a" || asAscii(head, 0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (
    head.length >= 12 &&
    asAscii(head, 0, 4) === "RIFF" &&
    asAscii(head, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }
  if (head.length >= 5 && asAscii(head, 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  if (sniffsAsHtml(head)) {
    return "text/html";
  }
  return null;
}

/** Map a MIME → conventional file extension used in storage_key. */
export function extensionFor(mime: string): string | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "text/html":
      return "html";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "text/csv":
      return "csv";
    case "application/json":
      return "json";
    case "application/pdf":
      return "pdf";
    default:
      return null;
  }
}

/** True when the byte head plausibly opens with HTML/XML markup.
 *  We accept any leading-`<` document because the alternative —
 *  matching a fixed `<!doctype html>` — would reject perfectly valid
 *  HTML fragments and SVG-as-HTML containers. */
function sniffsAsHtml(head: Uint8Array): boolean {
  // Skip optional UTF-8 BOM.
  let i = 0;
  if (
    head.length >= 3 &&
    head[0] === 0xef &&
    head[1] === 0xbb &&
    head[2] === 0xbf
  ) {
    i = 3;
  }
  // Skip leading whitespace.
  while (
    i < head.length &&
    (head[i] === 0x20 ||
      head[i] === 0x09 ||
      head[i] === 0x0a ||
      head[i] === 0x0d)
  ) {
    i++;
  }
  return i < head.length && head[i] === 0x3c; // '<'
}

function matchAt(buf: Uint8Array, off: number, sig: number[]): boolean {
  for (let i = 0; i < sig.length; i++) {
    if (buf[off + i] !== sig[i]) return false;
  }
  return true;
}

function asAscii(buf: Uint8Array, off: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(buf[off + i] ?? 0);
  return out;
}
