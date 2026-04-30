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
 *   - Multi-line values (e.g. a PEM private key needs '\n' literal in a
 *     single-line value, which is what GitHub-app private keys already
 *     do everywhere they appear in this codebase).
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
  for (const raw of text.split("\n")) {
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
