import { describe, expect, it } from "bun:test";
import {
  InvalidGraphQueryError,
  MultiStatementNotAllowedError,
} from "../../domain/errors.js";
import {
  assertSafeAgentQuery,
  assertSingleStatement,
  countStatements,
} from "./surreal-query-guard.js";

/**
 * Regression tests for the t03 P0 #2 SurrealQL guard. The bug shape we
 * are defending against: agent in workspace A submits a body that
 * either flips the SurrealDB connection to another workspace's database
 * mid-request (`USE DB ws_b_coll_x`) or smuggles forbidden DDL behind
 * a benign-looking SELECT. Both must be refused before the body
 * reaches `/sql`.
 */
describe("assertSafeAgentQuery", () => {
  describe("rejects forbidden directives", () => {
    const forbidden = [
      "USE DB col_workspace_b_ideas; SELECT * FROM person;",
      "use db col_workspace_b_ideas; SELECT * FROM person;",
      "USE NS x DB y;",
      "DEFINE TABLE secrets SCHEMALESS;",
      "REMOVE DATABASE col_workspace_b_ideas;",
      "INFO FOR ROOT;",
      "info for root;",
      "INFO FOR NS;",
      "INFO FOR NAMESPACE;",
    ];
    for (const q of forbidden) {
      it(`refuses: ${q.slice(0, 60)}`, () => {
        expect(() => assertSafeAgentQuery(q)).toThrow(InvalidGraphQueryError);
      });
    }
  });

  describe("comment-hidden directives are caught", () => {
    it("c-style /* */ does not hide USE", () => {
      // The directive is real; the comment is just decoration.
      expect(() =>
        assertSafeAgentQuery("SELECT 1; /* friendly */ USE DB foreign;"),
      ).toThrow(InvalidGraphQueryError);
    });

    it("line `-- to EOL` does not hide USE on a later line", () => {
      const q = `-- harmless
USE DB foreign;`;
      expect(() => assertSafeAgentQuery(q)).toThrow(InvalidGraphQueryError);
    });

    it("hash `# to EOL` does not hide USE on a later line", () => {
      const q = `# fine
USE DB foreign;`;
      expect(() => assertSafeAgentQuery(q)).toThrow(InvalidGraphQueryError);
    });

    it("USE appearing only inside a /* */ comment is allowed", () => {
      // The directive is *inside* the comment, not after it. After
      // stripping the comment there's no USE token left to match.
      expect(() =>
        assertSafeAgentQuery("/* USE NS foo */ SELECT * FROM person;"),
      ).not.toThrow();
    });
  });

  describe("string-literal hidden directives are allowed", () => {
    it("USE inside a single-quoted string is not a directive", () => {
      // `name = 'USE this in marketing'` is a legitimate filter value.
      expect(() =>
        assertSafeAgentQuery("SELECT * FROM idea WHERE title = 'USE this';"),
      ).not.toThrow();
    });
    it("escaped quote inside a string literal does not terminate early", () => {
      // If the escape handling were wrong, the trailing `USE` after the
      // string would be exposed and would (correctly) get blocked.
      // With proper escape handling, the literal swallows USE and the
      // body is allowed.
      expect(() =>
        assertSafeAgentQuery(
          "SELECT * FROM idea WHERE title = 'it\\'s about USE';",
        ),
      ).not.toThrow();
    });
  });

  describe("legitimate agent queries pass", () => {
    const ok = [
      "SELECT * FROM person LIMIT 100;",
      "SELECT count() FROM idea WHERE tag = 'launch';",
      "CREATE person CONTENT { name: 'Sarah' };",
      "RELATE person:1->WORKS_ON->project:2;",
      "INFO FOR DB;",
      "SELECT * FROM person WHERE description CONTAINS 'we are defined by what we ship';",
    ];
    for (const q of ok) {
      it(`allows: ${q.slice(0, 60)}`, () => {
        expect(() => assertSafeAgentQuery(q)).not.toThrow();
      });
    }
  });

  it("word boundaries prevent false positives on identifiers", () => {
    // `useful`, `defined_at`, `removed`, `information` must not trip
    // the directive regex — they share a prefix but are distinct
    // tokens.
    expect(() =>
      assertSafeAgentQuery(
        "SELECT useful, defined_at, removed, information FROM person;",
      ),
    ).not.toThrow();
  });
});

describe("countStatements / assertSingleStatement", () => {
  it("counts a single statement with no trailing semicolon as one", () => {
    expect(countStatements("SELECT * FROM person")).toBe(1);
  });
  it("counts a single statement with trailing semicolon as one", () => {
    expect(countStatements("SELECT * FROM person;")).toBe(1);
  });
  it("counts two statements", () => {
    expect(
      countStatements("SELECT * FROM person; SELECT * FROM idea;"),
    ).toBe(2);
  });
  it("ignores semicolons inside string literals", () => {
    expect(
      countStatements("SELECT * FROM idea WHERE title = 'a; b; c';"),
    ).toBe(1);
  });
  it("ignores semicolons inside comments", () => {
    expect(
      countStatements("/* ; ; ; */ SELECT * FROM idea;"),
    ).toBe(1);
  });
  it("ignores semicolons inside `-- to EOL` comments", () => {
    expect(
      countStatements("SELECT * FROM idea; -- ; ; ;"),
    ).toBe(1);
  });
  it("rejects multi-statement body", () => {
    expect(() =>
      assertSingleStatement("SELECT 1; SELECT 2;"),
    ).toThrow(MultiStatementNotAllowedError);
  });
  it("allows trailing whitespace after final semicolon", () => {
    expect(() =>
      assertSingleStatement("SELECT * FROM person;   \n  "),
    ).not.toThrow();
  });
  it("empty / whitespace-only body counts as zero statements", () => {
    expect(countStatements("")).toBe(0);
    expect(countStatements("   \n  ")).toBe(0);
  });
});
