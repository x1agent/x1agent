// Source-level guard for the chart-shipped agent-session egress
// NetworkPolicy. Closes the t05 P0 #1 security-sweep finding: before
// this template existed, agent-session pods had unrestricted egress on
// every enforcing CNI, which let a compromised agent reach the cloud
// metadata server (Workload Identity token theft) and any in-cluster
// Service including control-plane Postgres.
//
// We can't `helm template` from a bun-test (no helm binary in CI for
// unit tests) so this test asserts the template file's shape directly.
// `mise run install:plan` exercises the actual render against a real
// values file at install time, which catches templating syntax errors.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const templatePath = resolve(
  repoRoot,
  "deploy/helm/x1agent/templates/agent-session-networkpolicy.yaml",
);
const valuesPath = resolve(
  repoRoot,
  "deploy/helm/x1agent/values.yaml",
);

const template = readFileSync(templatePath, "utf8");
const values = readFileSync(valuesPath, "utf8");

describe("agent-session egress NetworkPolicy (chart)", () => {
  test("template exists and is gated by session.networkPolicy.enabled", () => {
    expect(template.length).toBeGreaterThan(0);
    expect(template).toContain(
      "{{- if .Values.session.networkPolicy.enabled }}",
    );
    expect(template).toContain("kind: NetworkPolicy");
    expect(template).toContain("policyTypes:\n    - Egress");
  });

  test("podSelector targets the labels pod-spec.ts stamps", () => {
    // pod-spec.ts:200-206 — these labels are what the api's job-watcher
    // imperatively writes onto session Jobs. If they drift, the policy
    // silently selects nothing and every session escapes the egress
    // lockdown.
    expect(template).toMatch(/podSelector:\s*\n\s*matchLabels:\s*\n\s*app:\s*x1agent\s*\n\s*component:\s*agent-session/);
  });

  test("blocks the cloud metadata server (169.254.169.254)", () => {
    // The whole point of the policy: prevent Workload Identity token
    // theft from the agent container. 169.254.0.0/16 is in the `except`
    // list AND must never appear in any `to: ipBlock: cidr:` allow rule.
    expect(template).toContain("- 169.254.0.0/16");
    // No allow rule should name the metadata IP.
    expect(template).not.toMatch(/cidr:\s*169\.254/);
    // Also check the literal IP isn't whitelisted via additionalEgressIPs
    // in the chart default values.
    expect(values).not.toMatch(/169\.254\.\d+\.\d+/);
  });

  test("blocks RFC1918 in-cluster traffic by default", () => {
    expect(template).toContain("- 10.0.0.0/8");
    expect(template).toContain("- 172.16.0.0/12");
    expect(template).toContain("- 192.168.0.0/16");
  });

  test("allows kube-dns on port 53 (UDP+TCP)", () => {
    expect(template).toContain("kubernetes.io/metadata.name: kube-system");
    expect(template).toContain("k8s-app: kube-dns");
    expect(template).toMatch(/port:\s*53\s*\n\s*protocol:\s*UDP/);
    expect(template).toMatch(/port:\s*53\s*\n\s*protocol:\s*TCP/);
  });

  test("allows egress to the api Service on the templated port", () => {
    // Sidecar reaches /api/internal/* on the api Service — git
    // credential fetch, share upload, file-token lookups. Without this
    // every session would fail at the TCP layer with
    // "error sending request for url".
    expect(template).toContain("app.kubernetes.io/component: api");
    expect(template).toContain("port: {{ .Values.api.port }}");
  });

  test("allows egress to nats:4222 when nats is enabled", () => {
    expect(template).toContain(
      "{{- if .Values.infra.nats.enabled }}",
    );
    expect(template).toContain("app.kubernetes.io/component: nats");
    expect(template).toContain("port: 4222");
  });

  test("does NOT allow egress to control-plane postgres", () => {
    // Session pods MUST NOT reach control-plane Postgres. The dev
    // manifest deliberately omits postgres from the session-egress
    // allowlist; the chart template must too.
    expect(template).not.toMatch(
      /component:\s*postgres[\s\S]{0,200}port:\s*5432/,
    );
  });

  test("exposes operator opt-out + extension knobs", () => {
    // Operators on non-enforcing CNIs (e.g. OrbStack kindnet) need an
    // opt-out; operators with private package registries / LLM endpoints
    // need an opt-in for extra destinations.
    expect(values).toMatch(/session:\s*\n[\s\S]*networkPolicy:\s*\n[\s\S]*enabled:\s*true/);
    expect(values).toContain("additionalEgressIPs: []");
    expect(values).toContain("additionalDeniedIPs: []");
    expect(values).toContain("allowedInternalServices: []");
  });
});
