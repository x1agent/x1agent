import { describe, it, expect, beforeEach } from "bun:test";
import * as k8s from "@kubernetes/client-node";
import { K8sPlatformSecretsStore } from "./store.js";

/**
 * Regression tests for K8sPlatformSecretsStore patch shape.
 *
 * Original bug: @kubernetes/client-node 1.x defaults the patch
 * Content-Type to `application/json-patch+json` (RFC 6902 — an array of
 * ops), but the store sends strategic-merge-patch bodies shaped like
 * `{data: {NAME: value}}`. Without the explicit header, the API server
 * rejects with HTTP 400 `error decoding patch: cannot unmarshal object
 * into Go value of type []handlers.jsonPatchOp`, and every admin UI key
 * save returns 500. The fix passes
 * `k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch)`
 * on all three call sites (setKey, clearKey, rolloutRestartApi).
 *
 * These tests stub `KubeConfig.makeApiClient` so we never hit a real
 * cluster; they record the options arg passed to each patch method and
 * run its middleware against a fake request to confirm the header
 * landed.
 */

interface PatchCall {
  params: {
    name: string;
    namespace: string;
    body: unknown;
  };
  options: k8s.ConfigurationOptions<unknown> | undefined;
}

function makeFakeApi(): {
  patchNamespacedSecret: (
    params: { name: string; namespace: string; body: unknown },
    opts?: k8s.ConfigurationOptions<unknown>,
  ) => Promise<void>;
  patchNamespacedDeployment: (
    params: { name: string; namespace: string; body: unknown },
    opts?: k8s.ConfigurationOptions<unknown>,
  ) => Promise<void>;
  createNamespacedSecret: (params: { namespace: string; body: unknown }) => Promise<void>;
  secretCalls: PatchCall[];
  deploymentCalls: PatchCall[];
  createCalls: Array<{ namespace: string; body: unknown }>;
  /** When true, the next patchNamespacedSecret call throws a 404 to
   *  trigger the create-on-the-fly fallback. */
  patchSecretShould404?: boolean;
} {
  const secretCalls: PatchCall[] = [];
  const deploymentCalls: PatchCall[] = [];
  const createCalls: Array<{ namespace: string; body: unknown }> = [];
  const api = {
    secretCalls,
    deploymentCalls,
    createCalls,
    patchSecretShould404: false,
    async patchNamespacedSecret(
      params: { name: string; namespace: string; body: unknown },
      opts?: k8s.ConfigurationOptions<unknown>,
    ): Promise<void> {
      secretCalls.push({ params, options: opts });
      if (api.patchSecretShould404) {
        const err = new Error("not found") as Error & { code: number };
        err.code = 404;
        throw err;
      }
    },
    async patchNamespacedDeployment(
      params: { name: string; namespace: string; body: unknown },
      opts?: k8s.ConfigurationOptions<unknown>,
    ): Promise<void> {
      deploymentCalls.push({ params, options: opts });
    },
    async createNamespacedSecret(params: {
      namespace: string;
      body: unknown;
    }): Promise<void> {
      createCalls.push(params);
    },
  };
  return api;
}

function makeKubeConfig(coreApi: unknown, appsApi: unknown): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  // makeApiClient is invoked twice in the constructor — once for
  // CoreV1Api, once for AppsV1Api. Return the right stub for each.
  (kc as unknown as { makeApiClient: (api: unknown) => unknown }).makeApiClient =
    (apiCtor: unknown) => {
      if (apiCtor === k8s.CoreV1Api) return coreApi;
      if (apiCtor === k8s.AppsV1Api) return appsApi;
      throw new Error(`unexpected api ctor in test: ${String(apiCtor)}`);
    };
  return kc;
}

/**
 * Walk the recorded options' middleware chain and ask each `pre` to act
 * on a stub request. Return the header values that were ultimately set
 * by `setHeaderParam`. The middleware shape comes from
 * `setHeaderMiddleware` in @kubernetes/client-node/dist/middleware.js —
 * the side effect (request.setHeaderParam) happens synchronously inside
 * `pre` BEFORE the wrapped observable is returned, so we don't need to
 * subscribe; just invoking `pre` is enough.
 */
function headersFromOptions(
  opts: k8s.ConfigurationOptions<unknown> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!opts) return headers;
  const o = opts as unknown as {
    middleware?: Array<{
      pre: (request: {
        setHeaderParam: (k: string, v: string) => void;
      }) => unknown;
    }>;
  };
  for (const m of o.middleware ?? []) {
    m.pre({
      setHeaderParam(k: string, v: string) {
        headers[k] = v;
      },
    });
  }
  return headers;
}

describe("K8sPlatformSecretsStore", () => {
  let api: ReturnType<typeof makeFakeApi>;
  let store: K8sPlatformSecretsStore;

  beforeEach(() => {
    api = makeFakeApi();
    const kc = makeKubeConfig(api, api);
    store = new K8sPlatformSecretsStore({
      kubeConfig: kc,
      namespace: "x1agent",
      secretName: "x1agent-platform-secrets",
      deploymentName: "api",
      now: () => new Date("2026-05-14T20:34:58Z"),
    });
  });

  describe("setKey", () => {
    it("sends a strategic-merge-patch (regression: was JSON Patch, broke every UI save)", async () => {
      await store.setKey("ANTHROPIC_API_KEY", "sk-ant-test");
      expect(api.secretCalls).toHaveLength(1);
      const headers = headersFromOptions(api.secretCalls[0]!.options);
      expect(headers["Content-Type"]).toBe(
        "application/strategic-merge-patch+json",
      );
    });

    it("base64-encodes the value into a body shaped {data: {NAME: <b64>}}", async () => {
      await store.setKey("ANTHROPIC_API_KEY", "sk-ant-test");
      const body = api.secretCalls[0]!.params.body as {
        data: Record<string, string>;
      };
      expect(body.data.ANTHROPIC_API_KEY).toBe(
        Buffer.from("sk-ant-test", "utf8").toString("base64"),
      );
    });

    it("falls back to create when patch returns 404 (fresh install)", async () => {
      api.patchSecretShould404 = true;
      await store.setKey("ANTHROPIC_API_KEY", "sk-ant-test");
      expect(api.secretCalls).toHaveLength(1);
      expect(api.createCalls).toHaveLength(1);
      const body = api.createCalls[0]!.body as {
        kind: string;
        metadata: { name: string };
        data: Record<string, string>;
      };
      expect(body.kind).toBe("Secret");
      expect(body.metadata.name).toBe("x1agent-platform-secrets");
      expect(body.data.ANTHROPIC_API_KEY).toBe(
        Buffer.from("sk-ant-test", "utf8").toString("base64"),
      );
    });
  });

  describe("clearKey", () => {
    it("sends a strategic-merge-patch (regression guard)", async () => {
      await store.clearKey("ANTHROPIC_API_KEY");
      expect(api.secretCalls).toHaveLength(1);
      const headers = headersFromOptions(api.secretCalls[0]!.options);
      expect(headers["Content-Type"]).toBe(
        "application/strategic-merge-patch+json",
      );
    });

    it("uses a null-valued data field — kube interprets that as remove-key", async () => {
      await store.clearKey("ANTHROPIC_API_KEY");
      const body = api.secretCalls[0]!.params.body as {
        data: Record<string, unknown>;
      };
      expect(body.data.ANTHROPIC_API_KEY).toBeNull();
    });

    it("is idempotent — a 404 on the Secret is treated as no-op success", async () => {
      api.patchSecretShould404 = true;
      // Should resolve, not throw.
      await store.clearKey("ANTHROPIC_API_KEY");
      expect(api.secretCalls).toHaveLength(1);
      // And it should NOT try to create the Secret on clear.
      expect(api.createCalls).toHaveLength(0);
    });
  });

  describe("rolloutRestartApi", () => {
    it("sends a strategic-merge-patch (regression guard)", async () => {
      await store.rolloutRestartApi();
      expect(api.deploymentCalls).toHaveLength(1);
      const headers = headersFromOptions(api.deploymentCalls[0]!.options);
      expect(headers["Content-Type"]).toBe(
        "application/strategic-merge-patch+json",
      );
    });

    it("annotates the pod template with kubectl.kubernetes.io/restartedAt — the canonical rollout trigger", async () => {
      await store.rolloutRestartApi();
      const body = api.deploymentCalls[0]!.params.body as {
        spec: {
          template: {
            metadata: { annotations: Record<string, string> };
          };
        };
      };
      expect(
        body.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"],
      ).toBe("2026-05-14T20:34:58.000Z");
    });

    it("targets the configured deployment name", async () => {
      await store.rolloutRestartApi();
      expect(api.deploymentCalls[0]!.params.name).toBe("api");
      expect(api.deploymentCalls[0]!.params.namespace).toBe("x1agent");
    });
  });
});
