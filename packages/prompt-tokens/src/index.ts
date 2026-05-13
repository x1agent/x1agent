/**
 * @x1agent/prompt-tokens
 *
 * Shared parser for the inline `[image: <upload_id>]` wire-format token
 * embedded in user message bodies. See X1A-97 for the locked spec.
 *
 * Three consumers depend on this contract:
 *   1. Composer UI — inserts `[image: <id>]` into the user message body
 *      when an upload completes (writes tokens).
 *   2. Chat-history renderer — finds tokens in messages and replaces them
 *      with pills (reads tokens).
 *   3. Agent input shaper — finds tokens in incoming user messages and
 *      materializes file paths for the agent (reads tokens).
 *
 * Locking this contract once prevents drift across the three surfaces.
 *
 * Reserved (round-trip only — do not implement consumer behavior):
 *   `[file: <id>]`, `[audio: <id>]`, `[video: <id>]` parse as
 *   `{ kind: 'unknown', raw }` so future kinds can ship without breaking
 *   round-trip identity through the existing parser.
 */

export type Part =
  | { kind: "text"; value: string }
  | { kind: "image"; uploadId: string }
  | { kind: "unknown"; raw: string };

/** Default cap on image tokens per message (composer enforces; parser provides
 *  defense-in-depth via `truncateImageTokens`). */
export const MAX_IMAGE_TOKENS_PER_MESSAGE = 4;

/**
 * UUID v4/v7 source pattern. Hex is case-insensitive on parse; the composer
 * emits lowercase, but pasted content may carry uppercase.
 */
const UUID_SOURCE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const RESERVED_KINDS = ["image", "file", "audio", "video"] as const;
type ReservedKind = (typeof RESERVED_KINDS)[number];

/**
 * Matches a single well-formed token of any reserved kind.
 * The grammar is rigid: `[<kind>: <uuid>]` with exactly one space after
 * the colon and a UUID-shaped id. Anything that doesn't match this is
 * treated as plain text — including `[image: not-a-uuid]` or
 * `[image:  too-many-spaces]`.
 *
 * Recreated as a fresh RegExp inside callers because `g` regexes carry
 * stateful `lastIndex` between calls.
 */
function tokenRegex(): RegExp {
  return new RegExp(`\\[(image|file|audio|video): (${UUID_SOURCE})\\]`, "g");
}

/** The image-only regex, exposed so consumers (e.g. UI highlighter) can
 *  reuse the exact contract instead of redefining it. */
export const IMAGE_TOKEN_REGEX = (): RegExp =>
  new RegExp(`\\[image: (${UUID_SOURCE})\\]`, "g");

/**
 * Parse a message body into an ordered sequence of text and token parts.
 *
 * Guarantees:
 *   - `serializePromptTokens(parsePromptTokens(x)) === x` for every input.
 *   - Adjacent text parts are NOT merged; the parser only emits text for
 *     the gap between tokens (or the whole input when there are no
 *     tokens), so the original substrings are preserved verbatim.
 *   - A token preceded by a single backslash (`\[image: <id>]`) is
 *     treated as literal text. The backslash is preserved in the text
 *     part so the escape round-trips.
 *   - Malformed tokens (bad uuid, missing space, wrong kind) parse as
 *     plain text — never throw.
 */
export function parsePromptTokens(text: string): Part[] {
  if (text.length === 0) return [];

  const parts: Part[] = [];
  const re = tokenRegex();
  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;

    // Escape: a literal backslash directly before the `[` makes the whole
    // bracketed sequence plain text. We don't consume anything special
    // here — we just skip emitting a token for this match. The character
    // range will be folded into the surrounding text on a later iteration
    // (or by the final flush below).
    if (start > 0 && text.charCodeAt(start - 1) === 0x5c /* '\' */) {
      continue;
    }

    if (start > cursor) {
      parts.push({ kind: "text", value: text.slice(cursor, start) });
    }
    const kind = m[1] as ReservedKind;
    const id = m[2]!;
    if (kind === "image") {
      parts.push({ kind: "image", uploadId: id });
    } else {
      parts.push({ kind: "unknown", raw: m[0] });
    }
    cursor = end;
  }

  if (cursor < text.length) {
    parts.push({ kind: "text", value: text.slice(cursor) });
  }
  return parts;
}

/**
 * Reverse of `parsePromptTokens`. Concatenates text values verbatim,
 * renders image parts back into the canonical `[image: <uploadId>]`
 * form, and emits the preserved `raw` for unknown parts. This is the
 * pair that satisfies the round-trip identity in the parser docstring.
 */
export function serializePromptTokens(parts: readonly Part[]): string {
  let out = "";
  for (const p of parts) {
    switch (p.kind) {
      case "text":
        out += p.value;
        break;
      case "image":
        out += `[image: ${p.uploadId}]`;
        break;
      case "unknown":
        out += p.raw;
        break;
    }
  }
  return out;
}

/**
 * Convenience: extract upload ids in document order. Used by the agent
 * input shaper to materialize files into `/workspace/uploads/<id>.<ext>`,
 * and by the chat-history renderer to pre-fetch upload metadata.
 *
 * Order matches token order in the source text; duplicates are
 * preserved (the caller dedupes if it wants to).
 */
export function extractImageIds(text: string): string[] {
  return parsePromptTokens(text)
    .filter((p): p is Extract<Part, { kind: "image" }> => p.kind === "image")
    .map((p) => p.uploadId);
}

/**
 * Defense-in-depth helper. The composer enforces the cap on the way in;
 * this helper runs server-side on every incoming message to drop any
 * image tokens past `max`. Other kinds (text, unknown) pass through
 * untouched. Returns the rewritten text and the number of tokens
 * removed so the caller can surface a warning to the user.
 *
 * `max` defaults to `MAX_IMAGE_TOKENS_PER_MESSAGE` (4).
 */
export function truncateImageTokens(
  text: string,
  max: number = MAX_IMAGE_TOKENS_PER_MESSAGE,
): { text: string; truncated: number } {
  if (max < 0) max = 0;
  const parts = parsePromptTokens(text);
  let kept = 0;
  let truncated = 0;
  const out: Part[] = [];
  for (const p of parts) {
    if (p.kind === "image") {
      if (kept < max) {
        out.push(p);
        kept++;
      } else {
        truncated++;
      }
    } else {
      out.push(p);
    }
  }
  return { text: serializePromptTokens(out), truncated };
}
