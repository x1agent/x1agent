import * as k8s from "@kubernetes/client-node";
import type postgres from "postgres";
import type {
  AgentRepository,
  AgentId,
} from "@x1agent/domain-agents";
import type {
  SessionId,
  SessionRepository,
} from "@x1agent/domain-sessions";
import type {
  AgentRepoStore,
  InstallationId,
} from "@x1agent/domain-github";
import { buildSessionJob, type LinkedRepoForPod } from "./pod-spec.js";

type Sql = postgres.Sql<Record<string, unknown>>;

export interface JobWatcherConfig {
  sql: Sql;
  agents: AgentRepository;
  sessions: SessionRepository;
  agentRepos: AgentRepoStore;
  namespace: string;
  agentImage: string;
  sidecarImage: string;
  imagePullPolicy?: "IfNotPresent" | "Always" | "Never";
  apiUrl: string;
  apiInternalToken: string;
  natsUrl: string;
  anthropicApiKey?: string;
  /**
   * Dev-only: host home directory to mount `.claude` + `.claude.json`
   * from, for Max users. Empty string / undefined disables the mount.
   */
  hostHomeDir?: string;
  /**
   * Dev-only: host path to the exported Max OAuth credentials file.
   * Mounted to `/root/.claude/.credentials.json` so Claude Code
   * authenticates without an API key.
   */
  hostClaudeCredentialsFile?: string;
  /** Poll interval in ms. */
  intervalMs?: number;
  /** Called on fatal per-tick errors. Defaults to console.warn. */
  onError?: (err: unknown) => void;
}

export interface JobWatcherHandle {
  stop: () => Promise<void>;
}

/**
 * Single-replica Job watcher for slice 1. Polls every intervalMs for
 * sessions in state=pending, creates a Job per session, flips the row
 * to running. A single replica is safe; multi-replica will need
 * SELECT … FOR UPDATE SKIP LOCKED once we scale the api.
 */
export function startJobWatcher(cfg: JobWatcherConfig): JobWatcherHandle {
  const intervalMs = cfg.intervalMs ?? 5000;
  const onError = cfg.onError ?? ((e) => console.warn("[jobs] tick failed:", (e as Error).message));

  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch (err) {
    console.warn(
      `[jobs] not running in-cluster (${(err as Error).message}) — watcher disabled`,
    );
    return { async stop() {} };
  }
  // OrbStack's API server uses a self-signed cert. The cleanest knob
  // that bun's fetch honors is NODE_TLS_REJECT_UNAUTHORIZED=0 (set via
  // the pod env in dev). We still flip skipTLSVerify for good measure
  // so the k8s client's own validation doesn't fight us.
  if (
    process.env.K8S_SKIP_TLS_VERIFY === "true" ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  ) {
    const cluster = kc.getCurrentCluster();
    if (cluster) {
      cluster.skipTLSVerify = true;
    }
  }
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);

  let running = true;
  let ticking = false;

  const tick = async () => {
    if (!running || ticking) return;
    ticking = true;
    try {
      const pending = await cfg.sql<{ id: string }[]>`
        SELECT id FROM sessions WHERE status = 'pending'
        ORDER BY triggered_at ASC
        LIMIT 20
      `;
      for (const row of pending) {
        await launchSession(cfg, batchApi, row.id as SessionId).catch((err) =>
          console.warn(
            `[jobs] launch session ${row.id} failed: ${(err as Error).message}`,
          ),
        );
      }
    } catch (err) {
      onError(err);
    } finally {
      ticking = false;
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
    (handle as unknown as { unref: () => void }).unref();
  }
  void tick();
  console.log(`[jobs] watcher started (interval=${intervalMs}ms)`);

  return {
    async stop() {
      running = false;
      clearInterval(handle);
    },
  };
}

async function launchSession(
  cfg: JobWatcherConfig,
  batchApi: k8s.BatchV1Api,
  sessionId: SessionId,
): Promise<void> {
  const session = await cfg.sessions.findById(sessionId);
  if (!session || session.status !== "pending") return;
  const agent = await cfg.agents.findById(session.agentId as AgentId);
  if (!agent) {
    await cfg.sessions.updateStatus(sessionId, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: "agent not found",
    });
    return;
  }

  // Resolve workspace slug for the sidecar.
  const ws = await cfg.sql<{ slug: string; name: string }[]>`
    SELECT slug, name FROM workspaces WHERE id = ${agent.workspaceId}
  `;
  if (ws.length === 0) {
    await cfg.sessions.updateStatus(sessionId, {
      status: "failed",
      completedAt: new Date(),
      errorMessage: "workspace not found",
    });
    return;
  }

  const linked = await cfg.agentRepos.listRepos(agent.id);
  const installation = await cfg.agentRepos.getLinkedInstallation(agent.id);
  const repos: LinkedRepoForPod[] = installation
    ? linked.map((r) => ({
        repo_full_name: r.repoFullName,
        branch: r.branch,
        mount_path: r.mountPath,
        auto_push: r.autoPush,
        installation_id: installation as unknown as number,
      }))
    : [];

  // Scheduler-triggered sessions get heartbeat_md as the first user
  // message. User-triggered sessions start empty and wait for inject —
  // the detail page's MessageInput drives the conversation.
  const isScheduled = session.triggeredBy === "scheduler";
  const initialPrompt = isScheduled ? agent.heartbeatMd : "";

  const job = buildSessionJob({
    sessionId: session.id,
    agentId: agent.id,
    agentSlug: agent.slug,
    workspaceSlug: ws[0]!.slug,
    workspaceName: ws[0]!.name,
    agentPrompt: initialPrompt,
    systemPromptText: agent.systemPrompt,
    heartbeatMd: agent.heartbeatMd,
    sessionMode: "interactive",
    idleTimeoutMs: 900_000,
    maxTurns: 200,
    repos,
    apiUrl: cfg.apiUrl,
    apiInternalToken: cfg.apiInternalToken,
    natsUrl: cfg.natsUrl,
    agentImage: cfg.agentImage,
    sidecarImage: cfg.sidecarImage,
    imagePullPolicy: cfg.imagePullPolicy,
    anthropicApiKey: cfg.anthropicApiKey,
    hostHomeDir: cfg.hostHomeDir,
    hostClaudeCredentialsFile: cfg.hostClaudeCredentialsFile,
    namespace: cfg.namespace,
  });

  try {
    await batchApi.createNamespacedJob({ namespace: cfg.namespace, body: job });
  } catch (err) {
    const status = (err as { code?: number; body?: { message?: string } }).code;
    const message = (err as { body?: { message?: string } }).body?.message ??
      (err as Error).message;
    if (status === 409) {
      // Job already exists from a previous attempt; treat as running.
      console.log(
        `[jobs] Job for session ${session.id} already exists — marking running`,
      );
    } else {
      console.warn(
        `[jobs] Job create for session ${session.id} failed: ${message}`,
      );
      await cfg.sessions.updateStatus(sessionId, {
        status: "failed",
        completedAt: new Date(),
        errorMessage: `k8s create: ${message}`,
      });
      return;
    }
  }

  await cfg.sessions.updateStatus(sessionId, { status: "running" });
  console.log(`[jobs] launched session ${session.id}`);
}

// Export used by unit tests to avoid hitting a real cluster.
export const _testing = { launchSession };
