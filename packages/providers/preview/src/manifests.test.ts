import { describe, it, expect } from "bun:test";
import {
  buildDeployment,
  buildIngress,
  buildKanikoJob,
  buildService,
  type PreviewDeploymentInputs,
} from "./manifests.js";
import { parsePreviewSpec } from "./preview-spec.js";

const spec = parsePreviewSpec(`
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
  env:
    - name: NODE_ENV
      value: production
    - name: PUBLIC_URL
      from: preview.self_url
  resources:
    requests: { cpu: 200m, memory: 512Mi }
    limits:   { cpu: 1, memory: 1Gi }
`);

const inputs: PreviewDeploymentInputs = {
  slug: "hirer-app",
  namespace: "x1-previews",
  image:
    "x1-registry.x1agent.svc.cluster.local:5000/previews/hirer-app:abc1234",
  spec,
  host: "hirer-app.preview.local.x1agent.dev",
  tlsSecretName: "x1agent-wildcard",
  selfUrl: "https://hirer-app.preview.local.x1agent.dev",
};

describe("buildDeployment", () => {
  const d = buildDeployment(inputs);

  it("names + namespaces the deployment by slug", () => {
    expect(d.metadata?.name).toBe("hirer-app");
    expect(d.metadata?.namespace).toBe("x1-previews");
  });

  it("runs one replica targeting the spec's port", () => {
    expect(d.spec?.replicas).toBe(1);
    const container = d.spec!.template.spec!.containers![0]!;
    expect(container.image).toBe(inputs.image);
    expect(container.ports![0]!.containerPort).toBe(4321);
  });

  it("resolves env.from='preview.self_url' to the inputs.selfUrl", () => {
    const env = d.spec!.template.spec!.containers![0]!.env!;
    const publicUrl = env.find((e) => e.name === "PUBLIC_URL");
    expect(publicUrl?.value).toBe(
      "https://hirer-app.preview.local.x1agent.dev",
    );
  });

  it("keeps literal env values verbatim", () => {
    const env = d.spec!.template.spec!.containers![0]!.env!;
    const nodeEnv = env.find((e) => e.name === "NODE_ENV");
    expect(nodeEnv?.value).toBe("production");
  });

  it("applies resources from the spec", () => {
    const c = d.spec!.template.spec!.containers![0]!;
    expect(c.resources?.requests).toEqual({ cpu: "200m", memory: "512Mi" });
    expect(c.resources?.limits).toEqual({ cpu: "1", memory: "1Gi" });
  });

  it("builds readiness + liveness probes from the healthcheck", () => {
    const c = d.spec!.template.spec!.containers![0]!;
    expect(c.readinessProbe?.httpGet?.path).toBe("/");
    expect(c.readinessProbe?.httpGet?.port).toBe(4321);
    expect(c.readinessProbe?.initialDelaySeconds).toBe(25);
    // Liveness uses 2x / 3x so restart loops don't thrash on a slow-to-warm pod.
    expect(c.livenessProbe?.initialDelaySeconds).toBe(50);
    expect(c.livenessProbe?.periodSeconds).toBe(30);
  });

  it("drops all Linux capabilities and forbids privilege escalation", () => {
    const c = d.spec!.template.spec!.containers![0]!;
    expect(c.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext?.capabilities?.drop).toContain("ALL");
  });
});

describe("buildDeployment — Zone-2 secret refs", () => {
  const specWithSecret = parsePreviewSpec(`
apiVersion: x1agent.io/v1
kind: PreviewSpec
metadata:
  name: app
spec:
  entrypoint: { kind: dockerfile, path: ./Dockerfile, buildContext: . }
  runtime:
    port: 4321
    healthcheck: { path: /, initialDelaySeconds: 5, periodSeconds: 5 }
  env:
    - name: API_KEY
      from: secret:MY_API_KEY
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: 1, memory: 512Mi }
`);

  it("emits valueFrom.secretKeyRef when a bundle is provided", () => {
    const d = buildDeployment({
      slug: "app",
      namespace: "x1-previews",
      image: "img",
      spec: specWithSecret,
      host: "app.preview.local",
      tlsSecretName: "tls",
      selfUrl: "https://app.preview.local",
      secretBundleName: "preview-secrets-app",
    });
    const env = d.spec!.template.spec!.containers![0]!.env!;
    const apiKey = env.find((e) => e.name === "API_KEY");
    expect(apiKey?.valueFrom?.secretKeyRef).toEqual({
      name: "preview-secrets-app",
      key: "MY_API_KEY",
    });
    expect(apiKey?.value).toBeUndefined();
  });

  it("falls back to empty value when no bundle is provided (manifest is still valid)", () => {
    const d = buildDeployment({
      slug: "app",
      namespace: "x1-previews",
      image: "img",
      spec: specWithSecret,
      host: "app.preview.local",
      tlsSecretName: "tls",
      selfUrl: "https://app.preview.local",
    });
    const env = d.spec!.template.spec!.containers![0]!.env!;
    const apiKey = env.find((e) => e.name === "API_KEY");
    expect(apiKey?.value).toBe("");
    expect(apiKey?.valueFrom).toBeUndefined();
  });
});

describe("buildDeployment — workspace env-binding injection", () => {
  // Spec declares NODE_ENV literal + PUBLIC_URL preview.self_url. The
  // workspace opted into ANTHROPIC_API_KEY via env_var_names; the
  // resolver stuffed the plaintext into the per-preview bundle's
  // stringData keyed by env-var name (deploy.ts), and now buildDeployment
  // has to surface it as a container env.
  it("injects extraEnvNames entries as secretKeyRefs into the bundle", () => {
    const d = buildDeployment({
      ...inputs,
      secretBundleName: "preview-secrets-hirer-app",
      extraEnvNames: ["ANTHROPIC_API_KEY"],
    });
    const env = d.spec!.template.spec!.containers![0]!.env!;
    const ant = env.find((e) => e.name === "ANTHROPIC_API_KEY");
    expect(ant?.valueFrom?.secretKeyRef).toEqual({
      name: "preview-secrets-hirer-app",
      key: "ANTHROPIC_API_KEY",
    });
    expect(ant?.value).toBeUndefined();
    // Pre-existing spec entries are untouched.
    expect(env.find((e) => e.name === "NODE_ENV")?.value).toBe("production");
  });

  it("when a spec env name collides with extraEnvNames, the binding wins", () => {
    // Spec sets NODE_ENV=production; workspace also exposes NODE_ENV.
    // The spec entry must be dropped so the manifest is K8s-valid (one
    // entry per name) and so the workspace override actually applies.
    const d = buildDeployment({
      ...inputs,
      secretBundleName: "preview-secrets-hirer-app",
      extraEnvNames: ["NODE_ENV"],
    });
    const env = d.spec!.template.spec!.containers![0]!.env!;
    const nodeEntries = env.filter((e) => e.name === "NODE_ENV");
    expect(nodeEntries).toHaveLength(1);
    expect(nodeEntries[0]!.valueFrom?.secretKeyRef).toEqual({
      name: "preview-secrets-hirer-app",
      key: "NODE_ENV",
    });
    expect(nodeEntries[0]!.value).toBeUndefined();
  });

  it("emits no extraEnv entries when the bundle is undefined (defensive)", () => {
    const d = buildDeployment({
      ...inputs,
      // deploy.ts guarantees a bundle whenever extraEnvNames is
      // non-empty, but the manifest builder must not crash if a future
      // caller forgets.
      extraEnvNames: ["ANTHROPIC_API_KEY"],
    });
    const env = d.spec!.template.spec!.containers![0]!.env!;
    expect(env.find((e) => e.name === "ANTHROPIC_API_KEY")).toBeUndefined();
  });

  it("is a no-op when extraEnvNames is empty", () => {
    const d = buildDeployment({
      ...inputs,
      secretBundleName: "preview-secrets-hirer-app",
      extraEnvNames: [],
    });
    const env = d.spec!.template.spec!.containers![0]!.env!;
    // Spec env present; nothing extra.
    expect(env.find((e) => e.name === "NODE_ENV")?.value).toBe("production");
    expect(env.find((e) => e.name === "PUBLIC_URL")?.value).toBe(
      "https://hirer-app.preview.local.x1agent.dev",
    );
    expect(env).toHaveLength(2);
  });
});

describe("buildService", () => {
  const s = buildService(inputs);

  it("routes port 80 to the container's runtime port", () => {
    expect(s.spec?.ports?.[0]?.port).toBe(80);
    expect(s.spec?.ports?.[0]?.targetPort).toBe(4321);
  });

  it("selects by app label", () => {
    expect(s.spec?.selector).toEqual({ app: "hirer-app" });
  });
});

describe("buildIngress", () => {
  const i = buildIngress(inputs);

  it("sets the host and TLS secret", () => {
    expect(i.spec?.rules?.[0]?.host).toBe(
      "hirer-app.preview.local.x1agent.dev",
    );
    expect(i.spec?.tls?.[0]?.hosts).toContain(
      "hirer-app.preview.local.x1agent.dev",
    );
    expect(i.spec?.tls?.[0]?.secretName).toBe("x1agent-wildcard");
  });

  it("uses the nginx ingress class and forces HTTPS", () => {
    expect(i.spec?.ingressClassName).toBe("nginx");
    expect(
      i.metadata?.annotations?.["nginx.ingress.kubernetes.io/ssl-redirect"],
    ).toBe("true");
  });
});

describe("buildKanikoJob", () => {
  const j = buildKanikoJob({
    jobName: "preview-build-hirer-app-abc1234",
    namespace: "x1agent",
    gitUrl: "https://github.com/hirer-co/app.git",
    gitRef: "refs/heads/feat/scaffold",
    dockerfilePath: "./Dockerfile",
    buildContext: ".",
    destination:
      "x1-registry.x1agent.svc.cluster.local:5000/previews/hirer-app:abc1234",
    insecureRegistry: true,
    accessToken: "ghs_fake_token_for_test",
  });

  it("embeds the github token into the clone URL using git://x-access-token", () => {
    const args = j.spec!.template.spec!.containers![0]!.args as string[];
    const contextArg = args.find((a) => a.startsWith("--context="));
    expect(contextArg).toBeDefined();
    expect(contextArg).toContain("git://x-access-token:ghs_fake_token_for_test@");
    expect(contextArg).toContain("github.com/hirer-co/app.git");
    expect(contextArg).toContain("#refs/heads/feat/scaffold");
  });

  it("passes --dockerfile + --destination in args", () => {
    const args = j.spec!.template.spec!.containers![0]!.args as string[];
    expect(args).toContain("--dockerfile=./Dockerfile");
    expect(args).toContain(
      "--destination=x1-registry.x1agent.svc.cluster.local:5000/previews/hirer-app:abc1234",
    );
  });

  it("adds --insecure and --skip-tls-verify for insecure registry", () => {
    const args = j.spec!.template.spec!.containers![0]!.args as string[];
    expect(args).toContain("--insecure");
    expect(args).toContain("--skip-tls-verify");
  });

  it("caps wall-clock time (activeDeadlineSeconds) at 1800s", () => {
    expect(j.spec?.activeDeadlineSeconds).toBe(1800);
  });

  it("does not retry busted builds indefinitely (backoffLimit = 1)", () => {
    expect(j.spec?.backoffLimit).toBe(1);
  });

  it("tags the Job with the preview slug for reaping + observability", () => {
    expect(j.metadata?.labels?.["preview-slug"]).toBe("hirer-app-abc1234");
    expect(j.metadata?.labels?.["component"]).toBe("preview-build");
  });
});

describe("buildKanikoJob — secure registry path", () => {
  it("omits --insecure when insecureRegistry=false", () => {
    const j = buildKanikoJob({
      jobName: "preview-build-secure",
      namespace: "x1agent",
      gitUrl: "https://github.com/acme/app.git",
      gitRef: "refs/heads/main",
      dockerfilePath: "./Dockerfile",
      buildContext: ".",
      destination: "ghcr.io/acme/app:v1",
      insecureRegistry: false,
      accessToken: "ghs_x",
    });
    const args = j.spec!.template.spec!.containers![0]!.args as string[];
    expect(args).not.toContain("--insecure");
    expect(args).not.toContain("--skip-tls-verify");
  });
});

describe("buildKanikoJob — serviceAccountName", () => {
  it("sets serviceAccountName on the pod spec when provided (Workload Identity for AR push)", () => {
    const j = buildKanikoJob({
      jobName: "preview-build-wi",
      namespace: "x1agent",
      gitUrl: "https://github.com/acme/app.git",
      gitRef: "refs/heads/main",
      dockerfilePath: "./Dockerfile",
      buildContext: ".",
      destination:
        "us-central1-docker.pkg.dev/proj/x1agent/preview-images/wi:abc",
      insecureRegistry: false,
      accessToken: "ghs_x",
      serviceAccountName: "x1agent-preview-build",
    });
    expect(j.spec?.template.spec?.serviceAccountName).toBe(
      "x1agent-preview-build",
    );
  });

  it("omits serviceAccountName when undefined (falls back to namespace default SA)", () => {
    const j = buildKanikoJob({
      jobName: "preview-build-default-sa",
      namespace: "x1agent",
      gitUrl: "https://github.com/acme/app.git",
      gitRef: "refs/heads/main",
      dockerfilePath: "./Dockerfile",
      buildContext: ".",
      destination: "x1-registry.x1agent.svc.cluster.local:5000/x:abc",
      insecureRegistry: true,
      accessToken: "ghs_x",
    });
    expect(j.spec?.template.spec?.serviceAccountName).toBeUndefined();
  });
});
