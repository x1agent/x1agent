// Regression test for security sweep t01 P0:
// the chart must not ship an anonymous NATS WebSocket listener that
// maps unauthenticated clients to a super-user identity.
//
// Background. The chart used to declare:
//
//   websocket {
//     port: 8080
//     no_tls: true
//     no_auth_user: "CN=x1agent-api"
//   }
//
// in the NATS ConfigMap. Anyone who could reach the listener was
// authenticated as `CN=x1agent-api`, the cluster-wide super-user
// permitted to publish + subscribe on every `x1.session.*`, `agent.>`
// and `_INBOX.>` subject. A public Ingress originally exposed the
// port; that Ingress was removed, but the listener was left in for
// CLI debugging — a single mis-labeled deployment or unenforced
// NetworkPolicy away from re-introducing the exploit.
//
// This test fails the build if `no_auth_user` reappears anywhere in
// the chart, regardless of which template adds it. It scans the raw
// template source rather than rendering through `helm` because
// (a) the only way `no_auth_user` ends up in rendered output is to
// be present in source — Go templating cannot synthesize the literal
// — and (b) CI does not install helm.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CHART_ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      // Skip the tests directory itself so this file's references
      // to the forbidden literal (in comments) don't trip the check.
      if (name === "tests") continue;
      out.push(...walk(path));
    } else if (st.isFile() && (path.endsWith(".yaml") || path.endsWith(".yml") || path.endsWith(".tpl"))) {
      out.push(path);
    }
  }
  return out;
}

// Strip Go template comments (`{{/* ... */}}`) since helm omits them
// from rendered output entirely — a historical narrative inside one
// is not a live config directive. We replace each match with the same
// number of newlines so 1-based line numbers in error messages stay
// accurate against the on-disk source.
//
// NOTE: this comment uses `//` rather than a JSDoc `/** */` block on
// purpose — a JSDoc block would be terminated by the literal `*/`
// embedded in the backtick example above, leaving the rest of the
// block to be parsed as code (Bun fails with `Unexpected }`).
function stripGoTemplateComments(content: string): string {
  return content.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, (match) => {
    const newlines = (match.match(/\n/g) ?? []).length;
    return "\n".repeat(newlines);
  });
}

test("chart contains no `no_auth_user` directive (NATS super-user mapping)", () => {
  const files = walk(CHART_ROOT);
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const content = stripGoTemplateComments(readFileSync(file, "utf8"));
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match the literal directive `no_auth_user` — NATS' config key
      // for the anonymous-client identity mapping. We ignore lines
      // that are commented out at the YAML/Go-template level (start
      // with `#` after optional whitespace) so historical narrative
      // doesn't trip the check.
      if (/no_auth_user/.test(line) && !/^\s*#/.test(line)) {
        offenders.push({ file, line: i + 1, text: line });
      }
    }
  }
  if (offenders.length > 0) {
    const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text.trim()}`).join("\n");
    throw new Error(
      `Found ${offenders.length} active \`no_auth_user\` directive(s) in the chart:\n${formatted}\n\n` +
        `This maps anonymous NATS clients to a named identity (typically the api's super-user). ` +
        `See deploy/helm/x1agent/tests/no-auth-user.test.ts for the full rationale.`,
    );
  }
  expect(offenders).toEqual([]);
});

test("chart NATS ConfigMap has no `websocket {` listener block", () => {
  const files = walk(CHART_ROOT);
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const content = stripGoTemplateComments(readFileSync(file, "utf8"));
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // NATS' config grammar opens a websocket listener with
      // `websocket {`. We deliberately match the opening brace so we
      // don't trip on the word "websocket" in surrounding YAML
      // (Service port names, comments, etc.) — only the actual
      // listener declaration.
      if (/^\s*websocket\s*\{/.test(line)) {
        offenders.push({ file, line: i + 1, text: line });
      }
    }
  }
  if (offenders.length > 0) {
    const formatted = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text.trim()}`).join("\n");
    throw new Error(
      `Found ${offenders.length} \`websocket {\` block(s) in chart templates:\n${formatted}\n\n` +
        `The browser uses the api's authenticated ws-bridge (wss://api.<base>/api/ws); ` +
        `there is no remaining consumer of a direct NATS WebSocket listener. ` +
        `If you genuinely need one back, route this through a design discussion first — ` +
        `the listener is the root cause of security sweep t01 P0.`,
    );
  }
  expect(offenders).toEqual([]);
});
