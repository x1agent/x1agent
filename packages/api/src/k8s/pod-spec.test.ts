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

  describe("USE_JETSTREAM_CONSUME propagation", () => {
    function sidecarEnv(): Array<{ name: string; value?: string }> {
      const job = buildSessionJob(baseSpec("worker"));
      const sidecar = job.spec!.template.spec!.containers!.find(
        (c) => c.name === "sidecar",
      )!;
      return sidecar.env ?? [];
    }

    it("does not set USE_JETSTREAM_CONSUME when the api flag is absent", () => {
      const saved = process.env.USE_JETSTREAM_CONSUME;
      delete process.env.USE_JETSTREAM_CONSUME;
      try {
        expect(
          sidecarEnv().find((e) => e.name === "USE_JETSTREAM_CONSUME"),
        ).toBeUndefined();
      } finally {
        if (saved !== undefined) process.env.USE_JETSTREAM_CONSUME = saved;
      }
    });

    it("propagates USE_JETSTREAM_CONSUME=true when the api flag is set", () => {
      const saved = process.env.USE_JETSTREAM_CONSUME;
      process.env.USE_JETSTREAM_CONSUME = "true";
      try {
        const entry = sidecarEnv().find(
          (e) => e.name === "USE_JETSTREAM_CONSUME",
        );
        expect(entry).toBeDefined();
        expect(entry!.value).toBe("true");
      } finally {
        if (saved === undefined) delete process.env.USE_JETSTREAM_CONSUME;
        else process.env.USE_JETSTREAM_CONSUME = saved;
      }
    });
  });
});
