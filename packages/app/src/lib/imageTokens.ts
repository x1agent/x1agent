/**
 * Inline-image token format used by the composer to mark attached
 * uploads inside a user message: `[image: <upload-id>]`. The composer
 * appends these to the message body; the timeline renderer needs to
 * find them and swap each occurrence for an inline pill, leaving the
 * surrounding prose untouched.
 *
 * Why a regex + flat parser: the wire format is intentionally simple
 * so a future server-side rewrite (X1A-97) can use the exact same
 * regex without a markdown / AST dependency. The id must be a UUID
 * shape to keep parsing tight — accidental "[image: foo]" in user
 * prose stays as plain text.
 */

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const IMAGE_TOKEN_RE = new RegExp(
  `\\[image:\\s*(${UUID_RE.source})\\s*\\]`,
  "gi",
);

export type ImageTokenBlock =
  | { type: "text"; value: string }
  | { type: "image"; id: string };

/**
 * Split a message body into interleaved text and image-token blocks.
 * Adjacent whitespace around a token is preserved on the text side —
 * the renderer chooses whether to trim. Empty text blocks (between
 * back-to-back tokens) are dropped so we don't emit `<p></p>`.
 */
export function parseImageTokens(body: string): ImageTokenBlock[] {
  if (!body) return [];
  const blocks: ImageTokenBlock[] = [];
  let lastIndex = 0;
  IMAGE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_TOKEN_RE.exec(body)) !== null) {
    if (m.index > lastIndex) {
      const text = body.slice(lastIndex, m.index);
      if (text.length > 0) blocks.push({ type: "text", value: text });
    }
    blocks.push({ type: "image", id: m[1]!.toLowerCase() });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < body.length) {
    const text = body.slice(lastIndex);
    if (text.length > 0) blocks.push({ type: "text", value: text });
  }
  return blocks;
}

/** True if the body contains at least one image token. */
export function hasImageTokens(body: string): boolean {
  IMAGE_TOKEN_RE.lastIndex = 0;
  return IMAGE_TOKEN_RE.test(body);
}
