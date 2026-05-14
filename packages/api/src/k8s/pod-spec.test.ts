import { describe, it, expect } from "bun:test";
import { buildSessionJob, type SessionPodSpec, type AgentKind } from "./pod-spec.js";

function baseSpec(kind: AgentKind): SessionPodSpec {
  return {
    sessionId: "019da000-0000-7000-8000-000000000001",
    agentId: "019da000-0000-7000-8000-0000000000a1",
    agentSlug: "hirer-orchestrator",
    agentKind: kind,
    workspaceSlug: "default",
    workspaceName: "Default",
    agentPrompt: "",
    systemPromptText: "You are an agent.",
    heartbeatMd: "",
    sessionMode: "interactive",
    idleTimeoutMs: 15 * 60 * 1000,
    maxTurns: 40,
    repos: [],
    collections: [],
    apiUrl: "http://api:30001",
    apiInternalToken: "t",
    natsUrl: "nats://nats:4222",
    agentImage: "x1agent-agent:latest",
    sidecarImage: "x1agent-sidecar:latest",
    namespace: "x1agent",
  };
}

describe("buildSessionJob — pod shape by agent.kind", () => {
  describe("worker", () => {
    const job = buildSessionJob(baseSpec("worker"));
    const pod = job.spec!.template.spec!;

    it("has the 1h hard deadline", () => {
      expect(job.spec!.activeDeadlineSeconds).toBe(3600);
    });

    it("backoffLimit 0 — no retries", () => {
      expect(job.spec!.backoffLimit).toBe(0);
    });

    it("restartPolicy Never — a crashed worker is a failed session", () => {
      expect(pod.restartPolicy).toBe("Never");
    });

    it("uses emptyDir workspace — no persistence between runs", () => {
      const ws = pod.volumes!.find((v) => v.name === "workspace")!;
      expect(ws.emptyDir).toBeDefined();
      expect(ws.persistentVolumeClaim).toBeUndefined();
    });

    it("requests full 1Gi / 500m for active work", () => {
      const agent = pod.containers!.find((c) => c.name === "agent")!;
      expect(agent.resources!.requests).toEqual({ memory: "1Gi", cpu: "500m" });
    });
  });

  describe("orchestrator", () => {
    const job = buildSessionJob(baseSpec("orchestrator"));
    const pod = job.spec!.template.spec!;

    it("has no activeDeadlineSeconds — orchestrators live for days", () => {
      expect(job.spec!.activeDeadlineSeconds).toBeUndefined();
    });

    it("backoffLimit 6 — tolerates pod restarts", () => {
      expect(job.spec!.backoffLimit).toBe(6);
    });

    it("restartPolicy OnFailure — kubelet respawns on crash; SDK resumes from PVC", () => {
      expect(pod.restartPolicy).toBe("OnFailure");
    });

    it("uses a PVC workspace — transcript survives pod restart", () => {
      const ws = pod.volumes!.find((v) => v.name === "workspace")!;
      expect(ws.persistentVolumeClaim).toBeDefined();
      expect(ws.emptyDir).toBeUndefined();
    });

    it("PVC claim name is session-scoped", () => {
      const ws = pod.volumes!.find((v) => v.name === "workspace")!;
      expect(ws.persistentVolumeClaim!.claimName).toMatch(/^x1-session-/);
    });

    it("requests 512Mi / 50m — mostly idle, burstable to limit when active", () => {
      const agent = pod.containers!.find((c) => c.name === "agent")!;
      expect(agent.resources!.requests).toEqual({ memory: "512Mi", cpu: "50m" });
      expect(agent.resources!.limits).toEqual({ memory: "2Gi", cpu: "1" });
    });
  });

  describe("scheduled", () => {
    const job = buildSessionJob(baseSpec("scheduled"));
    const pod = job.spec!.template.spec!;

    it("shares the worker shape — disposable, 1h cap", () => {
      expect(job.spec!.activeDeadlineSeconds).toBe(3600);
      expect(job.spec!.backoffLimit).toBe(0);
      expect(pod.restartPolicy).toBe("Never");
    });

    it("uses emptyDir workspace — scheduled ticks are stateless per run", () => {
      const ws = pod.volumes!.find((v) => v.name === "workspace")!;
      expect(ws.emptyDir).toBeDefined();
    });
  });

  describe("invariants across kinds", () => {
    it.each<AgentKind>(["worker", "orchestrator", "scheduled"])(
      "%s agent runs as uid 1000 non-root with capabilities dropped",
      (kind) => {
        const job = buildSessionJob(baseSpec(kind));
        const agent = job.spec!.template.spec!.containers!.find(
          (c) => c.name === "agent",
        )!;
        expect(agent.securityContext!.runAsUser).toBe(1000);
        expect(agent.securityContext!.runAsNonRoot).toBe(true);
        expect(agent.securityContext!.capabilities!.drop).toContain("ALL");
      },
    );

    // t02/t05 P0 (X1A-96 follow-up): API_INTERNAL_TOKEN authorises every
    // /api/internal/* route for every user / installation in the install.
    // Putting it on the agent container collapsed the documented trust
    // boundary (the agent is untrusted; the sidecar is the boundary).
    // The agent → upload path now goes through the sidecar's
    // /uploads/read credential proxy, exactly like git creds and OAuth
    // tokens. This regression guard fails the build if anyone ever
    // re-adds the env to the agent container.
    it.each<AgentKind>(["worker", "orchestrator", "scheduled"])(
      "%s pod: API_INTERNAL_TOKEN is NEVER set on the agent container (trust boundary)",
      (kind) => {
        const job = buildSessionJob(baseSpec(kind));
        const agent = job.spec!.template.spec!.containers!.find(
          (c) => c.name === "agent",
        )!;
        expect(
          (agent.env ?? []).find((e) => e.name === "API_INTERNAL_TOKEN"),
        ).toBeUndefined();
      },
    );

    it.each<AgentKind>(["worker", "orchestrator", "scheduled"])(
      "%s pod: API_INTERNAL_TOKEN IS still set on the sidecar container — sidecar is the trust boundary",
      (kind) => {
        const job = buildSessionJob(baseSpec(kind));
        const sidecar = job.spec!.template.spec!.containers!.find(
          (c) => c.name === "sidecar",
        )!;
        const entry = (sidecar.env ?? []).find(
          (e) => e.name === "API_INTERNAL_TOKEN",
        );
        expect(entry).toBeDefined();
        expect(entry!.value).toBe("t"); // value from baseSpec
      },
    );

    it.each<AgentKind>(["worker", "orchestrator", "scheduled"])(
      "%s pod mounts the nats-tls secret on the sidecar",
      (kind) => {
        const job = buildSessionJob(baseSpec(kind));
        const pod = job.spec!.template.spec!;
        const sidecar = pod.containers!.find((c) => c.name === "sidecar")!;
        const mount = sidecar.volumeMounts!.find((m) => m.name === "nats-tls");
        expect(mount).toBeDefined();
        expect(mount!.mountPath).toBe("/etc/nats-tls");
        expect(mount!.readOnly).toBe(true);
      },
    );
  });

  describe("ANTHROPIC_MODEL propagation (X1A-40)", () => {
    function agentEnv(spec: SessionPodSpec): Array<{ name: string; value?: string }> {
      const job = buildSessionJob(spec);
      const agent = job.spec!.template.spec!.containers!.find(
        (c) => c.name === "agent",
      )!;
      return agent.env ?? [];
    }

    it("renders anthropicModel into the agent container's ANTHROPIC_MODEL env", () => {
      const spec = { ...baseSpec("worker"), anthropicModel: "claude-opus-4-1@20250101" };
      const env = agentEnv(spec);
      const m = env.find((e) => e.name === "ANTHROPIC_MODEL");
      expect(m?.value).toBe("claude-opus-4-1@20250101");
    });

    it("omits ANTHROPIC_MODEL when the spec leaves it undefined — SDK picks its own default", () => {
      const env = agentEnv(baseSpec("worker"));
      expect(env.find((e) => e.name === "ANTHROPIC_MODEL")).toBeUndefined();
    });
  });

  describe("USE_JETSTREAM_* propagation", () => {
    function sidecarEnv(): Array<{ name: string; value?: string }> {
      const job = buildSessionJob(baseSpec("worker"));
      const sidecar = job.spec!.template.spec!.containers!.find(
        (c) => c.name === "sidecar",
      )!;
      return sidecar.env ?? [];
    }

    function withEnv(
      vars: Record<string, string | undefined>,
      fn: () => void,
    ) {
      const saved: Record<string, string | undefined> = {};
      for (const k of Object.keys(vars)) saved[k] = process.env[k];
      try {
        for (const [k, v] of Object.entries(vars)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        fn();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it("does not set either flag when the api process has neither", () => {
      withEnv(
        { USE_JETSTREAM_PUBLISH: undefined, USE_JETSTREAM_CONSUME: undefined },
        () => {
          const env = sidecarEnv();
          expect(env.find((e) => e.name === "USE_JETSTREAM_PUBLISH")).toBeUndefined();
          expect(env.find((e) => e.name === "USE_JETSTREAM_CONSUME")).toBeUndefined();
        },
      );
    });

    it("propagates USE_JETSTREAM_PUBLISH=true when the api flag is set", () => {
      withEnv(
        { USE_JETSTREAM_PUBLISH: "true", USE_JETSTREAM_CONSUME: undefined },
        () => {
          const entry = sidecarEnv().find(
            (e) => e.name === "USE_JETSTREAM_PUBLISH",
          );
          expect(entry?.value).toBe("true");
        },
      );
    });

    it("propagates USE_JETSTREAM_CONSUME=true when the api flag is set", () => {
      withEnv(
        { USE_JETSTREAM_PUBLISH: undefined, USE_JETSTREAM_CONSUME: "true" },
        () => {
          const entry = sidecarEnv().find(
            (e) => e.name === "USE_JETSTREAM_CONSUME",
          );
          expect(entry?.value).toBe("true");
        },
      );
    });

    it("propagates both flags independently when both are set", () => {
      withEnv(
        { USE_JETSTREAM_PUBLISH: "true", USE_JETSTREAM_CONSUME: "true" },
        () => {
          const env = sidecarEnv();
          expect(env.find((e) => e.name === "USE_JETSTREAM_PUBLISH")?.value).toBe("true");
          expect(env.find((e) => e.name === "USE_JETSTREAM_CONSUME")?.value).toBe("true");
        },
      );
    });
  });

  describe("X1A-42 — git identity env on the agent container", () => {
    function agentEnvFor(
      spec: SessionPodSpec,
    ): Array<{ name: string; value?: string }> {
      const job = buildSessionJob(spec);
      const agent = job.spec!.template.spec!.containers!.find(
        (c) => c.name === "agent",
      )!;
      return agent.env ?? [];
    }

    it("emits no GIT_AUTHOR_* / GIT_COMMITTER_* when gitIdentity is unset (preserves x1agent[bot] fallback)", () => {
      const env = agentEnvFor(baseSpec("worker"));
      for (const name of [
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
      ]) {
        expect(env.find((e) => e.name === name)).toBeUndefined();
      }
    });

    it("emits all four GIT_* env vars on the agent container when gitIdentity is set", () => {
      const spec: SessionPodSpec = {
        ...baseSpec("worker"),
        gitIdentity: { name: "Jane Doe", email: "jane@github.com" },
      };
      const env = agentEnvFor(spec);
      expect(env.find((e) => e.name === "GIT_AUTHOR_NAME")?.value).toBe(
        "Jane Doe",
      );
      expect(env.find((e) => e.name === "GIT_AUTHOR_EMAIL")?.value).toBe(
        "jane@github.com",
      );
      // committer pair must match — git uses author for the human, committer
      // for who applied the commit. With an automated worker, both are the
      // same user; this is the standard pattern (matches `git commit
      // --author=…` while letting the env stand in for both).
      expect(env.find((e) => e.name === "GIT_COMMITTER_NAME")?.value).toBe(
        "Jane Doe",
      );
      expect(env.find((e) => e.name === "GIT_COMMITTER_EMAIL")?.value).toBe(
        "jane@github.com",
      );
    });

    it.each<AgentKind>(["worker", "orchestrator", "scheduled"])(
      "applies git identity uniformly across %s agents — sidecar/orchestrator commits attribute too",
      (kind) => {
        const spec: SessionPodSpec = {
          ...baseSpec(kind),
          gitIdentity: { name: "Bot Person", email: "bot+tests@example.com" },
        };
        const env = agentEnvFor(spec);
        expect(env.find((e) => e.name === "GIT_AUTHOR_NAME")?.value).toBe(
          "Bot Person",
        );
      },
    );

    it("places GIT_* env on the AGENT container, not the sidecar (the agent is the process running git commit)", () => {
      const spec: SessionPodSpec = {
        ...baseSpec("worker"),
        gitIdentity: { name: "Jane", email: "j@e.com" },
      };
      const job = buildSessionJob(spec);
      const sidecar = job.spec!.template.spec!.containers!.find(
        (c) => c.name === "sidecar",
      )!;
      expect(
        (sidecar.env ?? []).find((e) => e.name === "GIT_AUTHOR_NAME"),
      ).toBeUndefined();
      expect(
        (sidecar.env ?? []).find((e) => e.name === "GIT_COMMITTER_EMAIL"),
      ).toBeUndefined();
    });
  });
});
