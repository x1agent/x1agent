import { describe, it, expect } from "bun:test";
import {
  buildKanikoJob,
  parseDigestFromTerminationMessage,
} from "./build-job.js";

describe("buildKanikoJob", () => {
  describe("git context", () => {
    const job = buildKanikoJob({
      jobName: "preview-build-foo-abc",
      namespace: "x1agent",
      destination: "x1-registry.x1agent.svc.cluster.local:5000/previews/foo:abc12345",
      insecureRegistry: true,
      context: {
        kind: "git",
        gitUrl: "https://github.com/example/app.git",
        gitRef: "abcdef1234567890",
        dockerfilePath: "Dockerfile",
        buildContext: ".",
        accessToken: "ghs_test_token",
      },
    });

    const container = job.spec!.template!.spec!.containers[0]!;
    const args = container.args!;

    it("embeds the access token into the git context URL", () => {
      const ctx = args.find((a) => a.startsWith("--context="));
      expect(ctx).toContain("git://x-access-token:ghs_test_token@");
      expect(ctx).toContain("github.com/example/app.git#abcdef");
    });

    it("includes the dockerfile path arg", () => {
      expect(args).toContain("--dockerfile=Dockerfile");
    });

    it("does not mount a build-ctx volume", () => {
      expect(container.volumeMounts).toBeUndefined();
      expect(job.spec!.template!.spec!.volumes).toBeUndefined();
    });

    it("includes --insecure and --skip-tls-verify when registry is HTTP", () => {
      expect(args).toContain("--insecure");
      expect(args).toContain("--skip-tls-verify");
    });
  });

  describe("inline context", () => {
    const job = buildKanikoJob({
      jobName: "image-build-django-1",
      namespace: "x1agent",
      destination: "x1-registry.x1agent.svc.cluster.local:5000/ws/wsid/django:latest",
      insecureRegistry: true,
      context: {
        kind: "inline",
        configMapName: "image-build-django-1-ctx",
      },
    });

    const container = job.spec!.template!.spec!.containers[0]!;
    const args = container.args!;
    const volumes = job.spec!.template!.spec!.volumes;

    it("uses dir:// context pointing at the mounted ConfigMap", () => {
      expect(args).toContain("--context=dir:///build-ctx");
      expect(args).toContain("--dockerfile=/build-ctx/Dockerfile");
    });

    it("mounts the ConfigMap at /build-ctx", () => {
      expect(container.volumeMounts).toEqual([
        { name: "build-ctx", mountPath: "/build-ctx", readOnly: true },
      ]);
      expect(volumes).toEqual([
        { name: "build-ctx", configMap: { name: "image-build-django-1-ctx" } },
      ]);
    });

    it("never embeds a git URL", () => {
      const ctx = args.find((a) => a.startsWith("--context="));
      expect(ctx).not.toContain("git://");
    });
  });

  it("emits the digest-file flag pointing at /dev/termination-log", () => {
    const job = buildKanikoJob({
      jobName: "j",
      namespace: "x1agent",
      destination: "reg/foo:latest",
      insecureRegistry: false,
      context: { kind: "inline", configMapName: "cm" },
    });
    const args = job.spec!.template!.spec!.containers[0]!.args!;
    expect(args).toContain("--image-name-with-digest-file=/dev/termination-log");
  });

  it("merges custom labels onto the Job + Pod", () => {
    const job = buildKanikoJob({
      jobName: "j",
      namespace: "x1agent",
      destination: "reg/foo:latest",
      insecureRegistry: false,
      context: { kind: "inline", configMapName: "cm" },
      labels: { "x1-image-id": "img-123" },
    });
    expect(job.metadata!.labels).toMatchObject({
      app: "x1agent",
      component: "kaniko-build",
      "x1-image-id": "img-123",
    });
    expect(job.spec!.template!.metadata!.labels).toMatchObject({
      "x1-image-id": "img-123",
    });
  });
});

describe("parseDigestFromTerminationMessage", () => {
  it("parses Kaniko's image-name-with-digest output", () => {
    const msg =
      "x1-registry.x1agent.svc.cluster.local:5000/ws/wsid/django:latest@sha256:" +
      "f".repeat(64);
    const parsed = parseDigestFromTerminationMessage(msg);
    expect(parsed).toBe(
      "x1-registry.x1agent.svc.cluster.local:5000/ws/wsid/django@sha256:" +
        "f".repeat(64),
    );
  });

  it("returns null for empty / null / non-matching", () => {
    expect(parseDigestFromTerminationMessage(null)).toBeNull();
    expect(parseDigestFromTerminationMessage(undefined)).toBeNull();
    expect(parseDigestFromTerminationMessage("")).toBeNull();
    expect(parseDigestFromTerminationMessage("error: something went wrong")).toBeNull();
    expect(parseDigestFromTerminationMessage("foo@sha256:short")).toBeNull();
  });

  it("survives trailing whitespace / newlines", () => {
    const msg = `reg/foo:t@sha256:${"a".repeat(64)}\n\n  `;
    const parsed = parseDigestFromTerminationMessage(msg);
    expect(parsed).toBe(`reg/foo@sha256:${"a".repeat(64)}`);
  });
});
