import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * X1A-79 — `ArtifactCommentsSidebar` and `SharePill` once shipped
 * production builds where `useRef`, `useState`, `useEffect`, and
 * `useMemo` were referenced but never imported explicitly. Vite/HMR
 * tolerated it; the prod chunk threw `useRef is not defined` and
 * crashed the session route.
 *
 * The fix was already-shipped (commit 7e73f6b et al.). This test pins
 * the import line so a future refactor can't silently drop it again.
 *
 * Cheap static check — read the source, verify the React hook imports
 * we expect. We don't need to render either component to catch this
 * regression class.
 */

function readSrc(rel: string): string {
  return readFileSync(
    resolve(__dirname, "..", "features", "sessions", rel),
    "utf8",
  );
}

describe("X1A-79 — React hook imports on session sidebar components", () => {
  it("ArtifactCommentsSidebar imports useRef from react", () => {
    const src = readSrc("ArtifactCommentsSidebar.tsx");
    expect(src).toMatch(/import\s*\{[^}]*\buseRef\b[^}]*\}\s*from\s*["']react["']/);
  });

  it("ArtifactCommentsSidebar imports useEffect, useMemo, useState from react", () => {
    const src = readSrc("ArtifactCommentsSidebar.tsx");
    expect(src).toMatch(/import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*["']react["']/);
    expect(src).toMatch(/import\s*\{[^}]*\buseMemo\b[^}]*\}\s*from\s*["']react["']/);
    expect(src).toMatch(/import\s*\{[^}]*\buseState\b[^}]*\}\s*from\s*["']react["']/);
  });

  it("SharePill imports useEffect + useState from react", () => {
    const src = readSrc("SharePill.tsx");
    expect(src).toMatch(/import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*["']react["']/);
    expect(src).toMatch(/import\s*\{[^}]*\buseState\b[^}]*\}\s*from\s*["']react["']/);
  });
});
