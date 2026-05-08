import { ValidationError } from "@x1agent/kernel";

declare const dockerfileSourceBrand: unique symbol;
export type DockerfileSource = string & {
  readonly [dockerfileSourceBrand]: true;
};

/**
 * Allowed Dockerfile directives in workspace-authored images.
 *
 * The constraint: workspace builds run from a ConfigMap-mounted
 * Dockerfile with no surrounding build context, so any directive that
 * pulls files off the build host (`COPY`, `ADD`) cannot be honored.
 * `COPY --from=<image>` is fine because it copies from a remote image
 * Kaniko can pull, not from the local filesystem.
 *
 * `ADD` stays banned even though `--from=` would technically work,
 * because the auto-extract behavior on URLs and tarballs is a footgun
 * and `RUN curl … && tar xf …` is the explicit alternative.
 *
 * If an admin needs `COPY` from a real build context, that's Phase 3
 * (build-context tarball upload). For v1 we surface a clear error.
 */
const ALLOWED_DIRECTIVES = new Set([
  "FROM",
  "RUN",
  "ENV",
  "ARG",
  "WORKDIR",
  "ENTRYPOINT",
  "CMD",
  "LABEL",
  "USER",
  "EXPOSE",
  "VOLUME",
  "SHELL",
  "STOPSIGNAL",
  "HEALTHCHECK",
  "ONBUILD",
  "COPY", // only `COPY --from=...` is allowed; checked below
]);

const MAX_BYTES = 64 * 1024; // 64 KB; ConfigMap caps at 1 MB but UX hard cap.

export function DockerfileSource(raw: string): DockerfileSource {
  if (typeof raw !== "string") {
    throw new ValidationError("dockerfile_source", "must be a string");
  }
  const text = raw.replace(/\r\n/g, "\n");
  if (text.trim().length === 0) {
    throw new ValidationError(
      "dockerfile_source",
      "must contain at least one directive",
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
    throw new ValidationError(
      "dockerfile_source",
      `must be ${MAX_BYTES} bytes or fewer (got ${Buffer.byteLength(text, "utf8")})`,
    );
  }

  // Directive validation. Joins lines that end in a backslash so
  // multi-line RUN/COPY statements parse as one directive.
  const lines = text.split("\n");
  const joined: { directive: string; rest: string; lineNo: number }[] = [];
  let buf = "";
  let bufLineNo = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const stripped = line.replace(/\s+$/, "");
    if (buf === "" && (stripped.trim() === "" || stripped.trim().startsWith("#"))) {
      continue;
    }
    if (buf === "") {
      bufLineNo = i + 1;
    }
    if (stripped.endsWith("\\")) {
      buf += stripped.slice(0, -1) + " ";
      continue;
    }
    buf += stripped;
    const trimmed = buf.trim();
    if (trimmed.length > 0) {
      const m = trimmed.match(/^(\S+)\s*(.*)$/);
      if (m) {
        joined.push({
          directive: (m[1] ?? "").toUpperCase(),
          rest: m[2] ?? "",
          lineNo: bufLineNo,
        });
      }
    }
    buf = "";
  }
  if (buf.trim().length > 0) {
    // Trailing line with no newline: still parse it.
    const m = buf.trim().match(/^(\S+)\s*(.*)$/);
    if (m) {
      joined.push({
        directive: (m[1] ?? "").toUpperCase(),
        rest: m[2] ?? "",
        lineNo: bufLineNo,
      });
    }
  }

  if (joined.length === 0) {
    throw new ValidationError(
      "dockerfile_source",
      "must contain at least one directive (only comments/blank lines found)",
    );
  }
  if (joined[0]?.directive !== "FROM" && joined[0]?.directive !== "ARG") {
    // ARG before FROM is the only legal pre-FROM directive in Dockerfile syntax.
    throw new ValidationError(
      "dockerfile_source",
      `first directive must be FROM (got ${joined[0]?.directive} on line ${joined[0]?.lineNo})`,
    );
  }
  let sawFrom = joined[0]?.directive === "FROM";
  for (const { directive, rest, lineNo } of joined) {
    if (!ALLOWED_DIRECTIVES.has(directive)) {
      throw new ValidationError(
        "dockerfile_source",
        `disallowed directive ${directive} on line ${lineNo}; allowed: ${[...ALLOWED_DIRECTIVES].sort().join(", ")}`,
      );
    }
    if (directive === "ADD") {
      throw new ValidationError(
        "dockerfile_source",
        `ADD is not permitted on line ${lineNo}; use RUN curl/wget instead`,
      );
    }
    if (directive === "COPY") {
      // Only `COPY --from=<source>` is allowed: no local build context exists.
      // Strip flags first; flags begin with `--`.
      const tokens = rest.match(/--\S+/g) ?? [];
      const hasFromFlag = tokens.some((t) => /^--from=/.test(t));
      if (!hasFromFlag) {
        throw new ValidationError(
          "dockerfile_source",
          `COPY without --from=<image> is not permitted on line ${lineNo}; workspace builds have no local build context. Use COPY --from=<image> to copy from another image.`,
        );
      }
    }
    if (directive === "FROM") sawFrom = true;
  }
  if (!sawFrom) {
    throw new ValidationError(
      "dockerfile_source",
      "must contain at least one FROM directive",
    );
  }

  return text as DockerfileSource;
}

/**
 * Hash the Dockerfile content for change detection. Lets the API skip
 * re-queuing a build when the source didn't actually change (idempotent
 * PATCH). Hex-encoded SHA-256, lowercased.
 */
export function dockerfileHash(source: DockerfileSource): string {
  // Lazy import: keeps this file usable in tests without a node-only
  // dep at module-eval time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256")
    .update(source as unknown as string, "utf8")
    .digest("hex");
}
