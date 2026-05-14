import {
  InvalidGraphQueryError,
  MultiStatementNotAllowedError,
} from "../../domain/errors.js";

/**
 * Guards that sit between agent-controlled SurrealQL and the
 * SurrealDB HTTP `/sql` endpoint. Two threats:
 *
 *   1. Mid-statement `USE NS x DB y;` switches the connection's active
 *      database, so an agent in workspace A can read workspace B's
 *      data through the same HTTP request. We reject the entire body
 *      if it contains any directive that mutates the connection's
 *      scope or the install's schema (`USE`, `DEFINE`, `REMOVE`,
 *      `INFO FOR ROOT`, `INFO FOR NS`).
 *
 *   2. SurrealDB happily accepts multi-statement bodies. The agent
 *      surface has no legitimate need for multi-statement queries —
 *      only `provision` / `deprovision` ship DDL bundles, and those
 *      paths opt in via `SurrealClient.sql(..., { allowMultiStatement
 *      : true })`. We refuse anything else with >1 statement so a
 *      newly-discovered escape (e.g. a future directive we haven't
 *      enumerated) can't be smuggled past Layer 1 on the back of a
 *      benign SELECT.
 *
 * Both guards strip SurrealQL comments (line `--`, line `#`, and
 * block C-style) and string literals before scanning so a comment-
 * or string-hidden directive is still caught. See t03 P0 #2 in the
 * security sweep.
 */

const FORBIDDEN_DIRECTIVES = [
  // USE: switches active namespace/database mid-request. The actual
  // escape pivot.
  "USE",
  // DEFINE: agents must never alter schema (DEFINE NAMESPACE, DEFINE
  // DATABASE, DEFINE TABLE, DEFINE INDEX, DEFINE USER, DEFINE TOKEN,
  // DEFINE EVENT, ...). DDL is the provider service's job.
  "DEFINE",
  // REMOVE: schema teardown — same reason.
  "REMOVE",
  // INFO FOR ROOT / INFO FOR NS leak workspace existence, namespace
  // names, install-level identifiers an agent has no business seeing.
  // INFO FOR DB is fine — that's just the current collection.
] as const;

/**
 * Replaces every SurrealQL comment and string literal with the same
 * number of spaces. We preserve length and line shape so future error
 * messages that include column positions stay accurate.
 *
 * Comments: line "-- to EOL", line "# to EOL", and C-style block
 * comments. Strings: single-quoted, double-quoted, backtick-quoted.
 * SurrealQL uses backslash to escape inside string literals; we honor
 * that so an escaped quote doesn't terminate the string early.
 */
function stripCommentsAndStrings(raw: string): string {
  const out: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i]!;
    const next = i + 1 < n ? raw[i + 1] : "";

    // `-- to EOL`
    if (c === "-" && next === "-") {
      while (i < n && raw[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    // `# to EOL`
    if (c === "#") {
      while (i < n && raw[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    // `/* ... */`
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n) {
        if (raw[i] === "*" && i + 1 < n && raw[i + 1] === "/") {
          out.push("  ");
          i += 2;
          break;
        }
        out.push(raw[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      continue;
    }
    // string literal: ', ", `
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out.push(" ");
      i += 1;
      while (i < n) {
        const ch = raw[i]!;
        if (ch === "\\" && i + 1 < n) {
          // skip the escape pair so the next char doesn't end the
          // string early
          out.push("  ");
          i += 2;
          continue;
        }
        if (ch === quote) {
          out.push(" ");
          i += 1;
          break;
        }
        out.push(ch === "\n" ? "\n" : " ");
        i += 1;
      }
      continue;
    }

    out.push(c);
    i += 1;
  }
  return out.join("");
}

/**
 * Throws `InvalidGraphQueryError` if the query contains any directive
 * the agent surface is not allowed to issue. Case-insensitive,
 * whitespace-tolerant. Strips comments + string literals before
 * scanning so a comment-hidden directive followed by the real one is
 * still caught.
 */
export function assertSafeAgentQuery(rawQuery: string): void {
  const scrubbed = stripCommentsAndStrings(rawQuery);
  for (const directive of FORBIDDEN_DIRECTIVES) {
    // `\b<DIRECTIVE>\b` anchored on word boundaries so we don't false-
    // positive on identifiers like `defined_at` or `remove_user_id`.
    const re = new RegExp(`\\b${directive}\\b`, "i");
    if (re.test(scrubbed)) {
      throw new InvalidGraphQueryError(
        `contains forbidden directive ${directive}`,
      );
    }
  }
  // INFO FOR ROOT / INFO FOR NS. Two-token match — we don't ban plain
  // INFO so `INFO FOR DB` (collection-scoped, harmless) still passes.
  if (/\bINFO\s+FOR\s+(ROOT|NS|NAMESPACE)\b/i.test(scrubbed)) {
    throw new InvalidGraphQueryError(
      "contains forbidden directive INFO FOR ROOT/NS",
    );
  }
}

/**
 * Counts statement separators (`;`) outside string literals and
 * comments. Returns true if the body contains more than one
 * statement. Trailing semicolons after the final statement do not
 * count.
 */
export function countStatements(rawQuery: string): number {
  const scrubbed = stripCommentsAndStrings(rawQuery);
  let count = 0;
  for (let i = 0; i < scrubbed.length; i += 1) {
    if (scrubbed[i] === ";") {
      // Lookahead: only count this `;` if there's a non-whitespace
      // character after it. A trailing `;` is shorthand, not a
      // second statement.
      let j = i + 1;
      while (j < scrubbed.length && /\s/.test(scrubbed[j]!)) j += 1;
      if (j < scrubbed.length) count += 1;
    }
  }
  // Also count the implicit first statement when there's any body.
  return scrubbed.trim().length === 0 ? 0 : count + 1;
}

/**
 * Throws `MultiStatementNotAllowedError` if the body contains more
 * than one statement. The provision / deprovision call-paths opt out
 * of this guard via `SurrealClient.sql(..., { allowMultiStatement:
 * true })`.
 */
export function assertSingleStatement(rawQuery: string): void {
  if (countStatements(rawQuery) > 1) {
    throw new MultiStatementNotAllowedError();
  }
}
