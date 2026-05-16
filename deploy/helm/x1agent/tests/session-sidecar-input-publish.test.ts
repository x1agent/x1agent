// Regression test for the orchestrator → worker comms hole.
//
// Background: the orchestrator's `inject_message` MCP tool routes
// through packages/sidecar/src/channel.rs::publish_input_envelope,
// which publishes directly to `x1.session.<child-id>.input` on NATS.
// The `CN=session-sidecar` user used to have only
// `x1.session.*.events`, `*.audit`, `*.archive` in its publish allow
// list — every orchestrator attempt to message a spawned worker hit
// a `Permissions Violation` and the publish silently dropped. The
// orchestrator saw no error and the worker never woke. Symptom in
// the wild: "Try to spawn again - did it err" on an orchestrator
// session, with `kubectl logs ... -c sidecar` showing the violation.
//
// This test fails the build if `x1.session.*.input` ever falls out
// of the session-sidecar's publish allow list again. Source-scan
// rather than render through helm because (a) the literal can only
// reach rendered output if it's in source and (b) CI doesn't have
// helm.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHART_ROOT = new URL("..", import.meta.url).pathname;
const NATS_TEMPLATE = join(CHART_ROOT, "templates/nats.yaml");

function stripGoTemplateComments(content: string): string {
  return content.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, (match) => {
    const newlines = (match.match(/\n/g) ?? []).length;
    return "\n".repeat(newlines);
  });
}

function extractBlock(source: string, marker: string): string | null {
  const idx = source.indexOf(marker);
  if (idx === -1) return null;
  // Walk forward from the marker until we hit the next `user:` boundary
  // or two consecutive closing braces — close enough for a flat
  // permissions block.
  const tail = source.slice(idx, idx + 4000);
  return tail;
}

test("CN=session-sidecar publish allow includes x1.session.*.input", () => {
  const raw = stripGoTemplateComments(readFileSync(NATS_TEMPLATE, "utf8"));
  const block = extractBlock(raw, 'user: "CN=session-sidecar"');
  expect(block).not.toBeNull();
  // We pull just the publish-allow line to avoid matching the subscribe
  // line that has always listed input (sidecars consume their own
  // session's input subject).
  const publishLine = block!
    .split("\n")
    .find((l) => /publish:\s*\{\s*allow:/.test(l));
  expect(publishLine).toBeDefined();
  expect(publishLine!).toContain('"x1.session.*.input"');
});
