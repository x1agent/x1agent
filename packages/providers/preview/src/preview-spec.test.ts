import { describe, it, expect } from "bun:test";
import { parsePreviewSpec, PreviewSpecError } from "./preview-spec.js";

const minimalValid = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: hirer-app
spec:
  entrypoint:
    kind: dockerfile
    path: ./Dockerfile
    buildContext: .
  runtime:
    port: 4321
    healthcheck:
      path: /
      initialDelaySeconds: 25
      periodSeconds: 10
  env: []
  resources:
    requests: { cpu: 200m, memory: 512Mi }
    limits:   { cpu: 1000m, memory: 1Gi }
`;

describe("parsePreviewSpec — happy path", () => {
  it("parses a minimal dockerfile-kind spec and returns a typed PreviewSpec", () => {
    const spec = parsePreviewSpec(minimalValid);
    expect(spec.metadata.name).toBe("hirer-app");
    expect(spec.spec.entrypoint.kind).toBe("dockerfile");
    expect(spec.spec.entrypoint.path).toBe("./Dockerfile");
    expect(spec.spec.entrypoint.buildContext).toBe(".");
    expect(spec.spec.runtime.port).toBe(4321);
    expect(spec.spec.runtime.healthcheck.path).toBe("/");
    expect(spec.spec.runtime.healthcheck.initialDelaySeconds).toBe(25);
    expect(spec.spec.env).toHaveLength(0);
    expect(spec.spec.resources.requests).toEqual({
      cpu: "200m",
      memory: "512Mi",
    });
  });

  it("applies sensible defaults for optional fields", () => {
    const yamlWithDefaults = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: minimal
spec:
  entrypoint:
    kind: dockerfile
    path: ./Dockerfile
  runtime:
    port: 3000
    healthcheck:
      path: /healthz
  env: []
  resources:
    requests: {}
    limits: {}
`;
    const spec = parsePreviewSpec(yamlWithDefaults);
    expect(spec.spec.entrypoint.buildContext).toBe(".");
    expect(spec.spec.runtime.healthcheck.initialDelaySeconds).toBe(15);
    expect(spec.spec.runtime.healthcheck.periodSeconds).toBe(10);
    expect(spec.spec.resources.requests.cpu).toBe("200m");
    expect(spec.spec.resources.limits.cpu).toBe("1");
  });

  it("reads env vars with value + from fields", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: envtest
spec:
  entrypoint:
    kind: dockerfile
    path: ./Dockerfile
  runtime:
    port: 8080
    healthcheck: { path: / }
  env:
    - name: NODE_ENV
      value: production
    - name: PUBLIC_URL
      from: preview.self_url
  resources:
    requests: {}
    limits: {}
`;
    const spec = parsePreviewSpec(y);
    expect(spec.spec.env).toHaveLength(2);
    expect(spec.spec.env[0]!).toEqual({
      name: "NODE_ENV",
      value: "production",
      from: undefined,
    });
    expect(spec.spec.env[1]!).toEqual({
      name: "PUBLIC_URL",
      value: undefined,
      from: "preview.self_url",
    });
  });
});

describe("parsePreviewSpec — validation errors", () => {
  it.each([
    ["", "<root>"],
    ["apiVersion: wrong/v1", "apiVersion"],
    ["apiVersion: x1agent.io/v1", "kind"],
  ])("rejects malformed root: %p", (content, expectedField) => {
    try {
      parsePreviewSpec(content);
      throw new Error("expected PreviewSpecError");
    } catch (err) {
      expect(err).toBeInstanceOf(PreviewSpecError);
      expect((err as PreviewSpecError).field).toBe(expectedField);
    }
  });

  it("rejects invalid metadata.name (not DNS-1123 label)", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: Invalid_Name
spec: {}
`;
    expect(() => parsePreviewSpec(y)).toThrow(PreviewSpecError);
  });

  it("rejects non-dockerfile entrypoint kinds (v1 scope)", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: compose-app
spec:
  entrypoint:
    kind: compose
    path: ./docker-compose.yml
  runtime:
    port: 3000
    healthcheck: { path: / }
  env: []
  resources:
    requests: {}
    limits: {}
`;
    try {
      parsePreviewSpec(y);
      throw new Error("expected PreviewSpecError");
    } catch (err) {
      expect((err as PreviewSpecError).field).toBe("spec.entrypoint.kind");
      expect((err as PreviewSpecError).message).toContain("dockerfile");
    }
  });

  it("rejects invalid port", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: bad-port
spec:
  entrypoint: { kind: dockerfile, path: ./Dockerfile }
  runtime:
    port: 99999
    healthcheck: { path: / }
  env: []
  resources:
    requests: {}
    limits: {}
`;
    try {
      parsePreviewSpec(y);
      throw new Error("expected PreviewSpecError");
    } catch (err) {
      expect((err as PreviewSpecError).field).toBe("spec.runtime.port");
    }
  });

  it("accepts env.from='secret:NAME' as a Zone-2 reference", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: zone2
spec:
  entrypoint: { kind: dockerfile, path: ./Dockerfile }
  runtime:
    port: 3000
    healthcheck: { path: /healthz }
  env:
    - name: API_KEY
      from: secret:MY_API_KEY
  resources:
    requests: {}
    limits: {}
`;
    const s = parsePreviewSpec(y);
    expect(s.spec.env[0]?.from).toBe("secret:MY_API_KEY");
  });

  it("rejects env.from='secret:bad-name'", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: zone2-bad
spec:
  entrypoint: { kind: dockerfile, path: ./Dockerfile }
  runtime:
    port: 3000
    healthcheck: { path: /healthz }
  env:
    - name: API_KEY
      from: secret:lower-case
  resources:
    requests: {}
    limits: {}
`;
    try {
      parsePreviewSpec(y);
      throw new Error("expected PreviewSpecError");
    } catch (err) {
      expect((err as PreviewSpecError).field).toBe("spec.env[0].from");
    }
  });

  it("rejects unknown env.from form", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: zone2-bad
spec:
  entrypoint: { kind: dockerfile, path: ./Dockerfile }
  runtime:
    port: 3000
    healthcheck: { path: /healthz }
  env:
    - name: API_KEY
      from: configmap:foo
  resources:
    requests: {}
    limits: {}
`;
    try {
      parsePreviewSpec(y);
      throw new Error("expected PreviewSpecError");
    } catch (err) {
      expect((err as PreviewSpecError).field).toBe("spec.env[0].from");
    }
  });

  it("rejects healthcheck.path without leading slash", () => {
    const y = `
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: bad-hc
spec:
  entrypoint: { kind: dockerfile, path: ./Dockerfile }
  runtime:
    port: 3000
    healthcheck: { path: healthz }
  env: []
  resources:
    requests: {}
    limits: {}
`;
    try {
      parsePreviewSpec(y);
      throw new Error("expected PreviewSpecError");
    } catch (err) {
      expect((err as PreviewSpecError).field).toBe(
        "spec.runtime.healthcheck.path",
      );
    }
  });
});
