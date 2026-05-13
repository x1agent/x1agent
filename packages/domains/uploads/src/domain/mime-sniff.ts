/**
 * Magic-byte MIME sniff for the v1 image formats. Returns the
 * authoritative MIME or null if the bytes don't match any allowed
 * format. Intentionally a hand-rolled table so we don't pull a runtime
 * dependency for four well-known signatures.
 *
 * References:
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *   GIF   "GIF87a" | "GIF89a"
 *   WebP  "RIFF" .... "WEBP"
 *
 * The caller supplies the first ~32 bytes of the stored object. We
 * deliberately don't need a larger window — every supported format is
 * identifiable from the first 12 bytes.
 */
export function sniffImageMime(head: Uint8Array): string | null {
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
    default:
      return null;
  }
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
