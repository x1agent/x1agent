import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Minimal .env file reader/writer. Preserves comments, blank lines, and
 * the original order of entries. Sets/replaces values in place; appends
 * new keys at the bottom (under a "configure-managed" section so they
 * group cleanly).
 *
 * Quoting rules (intentionally narrow — .env.local is a developer file,
 * not a general parser):
 *   - If value has none of [whitespace, '#', '"', "'", '$', '\\'], write bare.
 *   - Otherwise, double-quote and escape '"' and '\\'.
 *
 * What it does NOT do:
 *   - Variable interpolation (mise reads these via dotenv-like behavior;
 *     we don't expand on write).
 *
 * What it DOES handle:
 *   - Multi-line double/single-quoted values. A PEM private key pasted as
 *     a real multi-line block (BEGIN/END markers on their own lines) is a
 *     supported on-disk shape because dotenv-style readers (mise, etc.)
 *     accept it, and operators paste private keys from GitHub that way.
 *     Previously the parser stopped at the first newline and silently
 *     truncated the value to `"-----BEGIN RSA PRIVATE KEY-----` (32 bytes)
 *     — `installs/up.ts` then pushed that placeholder into GSM, which
 *     broke the GitHub App OAuth flow in prod until the operator pushed
 *     the real PEM via `gcloud secrets versions add`.
 */

type Line =
  | { kind: "kv"; key: string; value: string; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "blank"; raw: string };

const APPENDED_SECTION_HEADER = "# === added by `mise run configure` ===";

export class EnvFile {
  private lines: Line[] = [];

  constructor(public readonly path: string) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      this.lines = parse(text);
    }
  }

  get(key: string): string | undefined {
    const line = this.lines.find((l) => l.kind === "kv" && l.key === key);
    if (!line || line.kind !== "kv") return undefined;
    return line.value;
  }

  /**
   * Returns true if the key is present (even with empty value), false
   * if the key is absent. Useful for distinguishing "user set it to
   * blank deliberately" from "never seen".
   */
  has(key: string): boolean {
    return this.lines.some((l) => l.kind === "kv" && l.key === key);
  }

  set(key: string, value: string): void {
    const idx = this.lines.findIndex(
      (l) => l.kind === "kv" && l.key === key,
    );
    if (idx >= 0) {
      this.lines[idx] = {
        kind: "kv",
        key,
        value,
        raw: serializeKv(key, value),
      };
      return;
    }
    // New key — make sure the appended section header exists.
    if (
      !this.lines.some(
        (l) => l.kind === "comment" && l.raw === APPENDED_SECTION_HEADER,
      )
    ) {
      if (this.lines.length > 0) {
        this.lines.push({ kind: "blank", raw: "" });
      }
      this.lines.push({ kind: "comment", raw: APPENDED_SECTION_HEADER });
    }
    this.lines.push({
      kind: "kv",
      key,
      value,
      raw: serializeKv(key, value),
    });
  }

  unset(key: string): void {
    this.lines = this.lines.filter((l) => !(l.kind === "kv" && l.key === key));
  }

  save(): void {
    const text = this.lines.map((l) => l.raw).join("\n") + "\n";
    writeFileSync(this.path, text, { mode: 0o600 });
  }
}

function parse(text: string): Line[] {
  const out: Line[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw === "") {
      out.push({ kind: "blank", raw: "" });
      continue;
    }
    if (raw.trimStart().startsWith("#")) {
      out.push({ kind: "comment", raw });
      continue;
    }
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      // Malformed — keep verbatim so we don't corrupt the file.
      out.push({ kind: "comment", raw });
      continue;
    }
    const key = raw.slice(0, eq).trim();
    const rest = raw.slice(eq + 1);
    // Multi-line quoted value: if `rest` opens with " or ' and that quote
    // isn't closed on the same line, consume lines until the matching
    // closing quote appears. Without this, a pasted multi-line PEM gets
    // truncated to its first line and (worse) the trailing lines become
    // bogus "comment" entries.
    const quote = openingQuote(rest);
    if (quote && !hasClosingQuoteOnSameLine(rest, quote)) {
      const collectedRaw: string[] = [raw];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const next = lines[j] ?? "";
        collectedRaw.push(next);
        if (lineEndsQuotedValue(next, quote)) {
          closed = true;
          break;
        }
      }
      if (closed) {
        const joinedRaw = collectedRaw.join("\n");
        const joinedRest = joinedRaw.slice(eq + 1);
        out.push({
          kind: "kv",
          key,
          value: parseValue(joinedRest),
          raw: joinedRaw,
        });
        i = j;
        continue;
      }
      // Unterminated — fall through to single-line behavior so we keep
      // the file readable. This matches the old, lossy behavior on
      // genuinely broken input.
    }
    out.push({ kind: "kv", key, value: parseValue(rest), raw });
  }
  // Trim trailing all-blank lines so save() doesn't grow the file.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (!last || last.kind !== "blank") break;
    out.pop();
  }
  return out;
}

function openingQuote(rest: string): '"' | "'" | undefined {
  const t = rest.trimStart();
  if (t.startsWith('"')) return '"';
  if (t.startsWith("'")) return "'";
  return undefined;
}

function hasClosingQuoteOnSameLine(rest: string, quote: '"' | "'"): boolean {
  const t = rest.trimStart();
  // Skip the opening quote and look for an unescaped matching quote in
  // the remainder of this line.
  return findUnescapedQuote(t.slice(1), quote) !== -1;
}

function lineEndsQuotedValue(line: string, quote: '"' | "'"): boolean {
  return findUnescapedQuote(line, quote) !== -1;
}

function findUnescapedQuote(s: string, quote: '"' | "'"): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && quote === '"') {
      // Only double-quoted strings honor backslash-escapes here.
      i++;
      continue;
    }
    if (c === quote) return i;
  }
  return -1;
}

function parseValue(raw: string): string {
  const t = raw.trim();
  if (t.length === 0) return "";
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    const inner = t.slice(1, -1);
    if (t.startsWith('"')) {
      return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return inner;
  }
  return t;
}

function serializeKv(key: string, value: string): string {
  if (needsQuoting(value)) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${key}="${escaped}"`;
  }
  return `${key}=${value}`;
}

function needsQuoting(v: string): boolean {
  return /[\s"'$#\\]/.test(v);
}
