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
import type { SessionEventRepository } from "@x1agent/domain-sessions";
import type { CollectionRepository } from "@x1agent/domain-collections";
import {
  buildSessionHistory,
  SESSION_RESUME_PROMPT,
  walkResumeChain,
  type Session as SessionEntity,
  type SessionEvent as SessionEventEntity,
} from "@x1agent/domain-sessions";
import type {
  SharedResource,
  SharedResourceRepository,
} from "@x1agent/agent-resources";
import {
  mintPostgresBranchCredential,
  type PostgresBranchMinter,
  type PostgresBranchRepository,
} from "@x1agent/agent-resources-postgres";
import {
  mintRedisBranchCredential,
  type RedisBranchMinter,
  type RedisBranchRepository,
} from "@x1agent/agent-resources-redis";
import {
  buildSessionJob,
  type AttachedCollectionForPod,
  type LinkedRepoForPod,
} from "./pod-spec.js";

type Sql = postgres.Sql<Record<string, unknown>>;

export interface JobWatcherConfig {
  sql: Sql;
  agents: AgentRepository;
  sessions: SessionRepository;
  agentRepos: AgentRepoStore;
  collections: CollectionRepository;
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
  /**
   * Shared-agent-resources plumbing. When `sharedResources` is present
   * the watcher enumerates installed resources per session, mints
   * per-branch credentials, and injects them as env via a per-session
   * K8s Secret. When null, session pods boot without DATABASE_URL etc.
   */
  /**
   * Session events repository — used at spawn time to assemble
   * /workspace/session_history.md when `session.resumedFromSessionId`
   * is set.
   */
  sessionEvents?: SessionEventRepository | null;
  sharedResources?: SharedResourceRepository | null;
  postgresMinter?: PostgresBranchMinter | null;
  postgresBranches?: PostgresBranchRepository | null;
  redisMinter?: RedisBranchMinter | null;
  redisBranches?: RedisBranchRepository | null;
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
        await launchSession(cfg, batchApi, kc, row.id as SessionId).catch((err) =>
          console.warn(
            `[jobs] launch session ${row.id} failed: ${(err as Error).message}`,
          ),
        );
      }
      await reconcileRunning(cfg, batchApi).catch((err) =>
        console.warn(`[jobs] reconcile failed: ${(err as Error).message}`),
      );
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
  kc: k8s.KubeConfig,
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
  // Resolve the agent's configured image if one is set. Falls back to
  // the deployment-wide default (AGENT_IMAGE env) when the agent has
  // no image_id pinned — preserves behavior for seeded agents and
  // agents created before the catalog landed.
  const imageRow = await cfg.sql<{ built_ref: string }[]>`
    SELECT i.built_ref
    FROM agents a
    JOIN agent_images i ON i.id = a.image_id
    WHERE a.id = ${agent.id}
  `;
  const resolvedAgentImage =
    imageRow[0]?.built_ref ?? cfg.agentImage;
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

  const attachedCollections = await cfg.collections.listCollectionsForAgent(
    agent.id,
  );
  const collections: AttachedCollectionForPod[] = attachedCollections.map(
    (c) => ({
      id: c.id,
      slug: c.slug,
      backend_handle: c.backendHandle,
      provider_type: c.providerType,
      is_default: c.isDefault,
    }),
  );

  // Scheduler-triggered sessions get heartbeat_md as the first user
  // message. User-triggered sessions start empty and wait for inject —
  // the detail page's MessageInput drives the conversation.
  // Resumed sessions get a canned prompt that points the agent at the
  // session-history markdown mounted into /workspace.
  const isScheduled = session.triggeredBy === "scheduler";
  const isResume = session.resumedFromSessionId !== null;
  const initialPrompt = isResume
    ? SESSION_RESUME_PROMPT
    : isScheduled
      ? agent.heartbeatMd
      : "";

  // Resume: walk the chain of prior sessions, fetch their events, and
  // stash the rendered markdown into a ConfigMap mounted at
  // /workspace/session_history.md in the agent container. The
  // ConfigMap is session-scoped and GC'd on Job TTL. If the events
  // repo isn't wired (dev without the session domain composed),
  // fall back to an empty history — the agent still boots, just
  // without prior context.
  const resumeHistoryConfigMapName = await maybeBuildResumeHistoryConfigMap(
    cfg,
    kc,
    session,
  );

  // Shared agent resources: mint per-branch credentials for every
  // installed resource, stuff them into a per-session Secret, and let
  // pod-spec reference it via envFrom. Augment the system prompt with
  // a usage block so the agent knows what the env vars mean.
  const { credentialsSecretName, promptAppend } = await mintSessionCredentials(
    cfg,
    kc,
    session.id,
    agent.workspaceId,
    repos,
  );

  const composedSystemPrompt = promptAppend
    ? `${agent.systemPrompt}\n\n${promptAppend}`
    : agent.systemPrompt;

  const job = buildSessionJob({
    sessionId: session.id,
    agentId: agent.id,
    agentSlug: agent.slug,
    workspaceSlug: ws[0]!.slug,
    workspaceName: ws[0]!.name,
    agentPrompt: initialPrompt,
    systemPromptText: composedSystemPrompt,
    heartbeatMd: agent.heartbeatMd,
    sessionMode: "interactive",
    idleTimeoutMs: 900_000,
    maxTurns: 200,
    repos,
    collections,
    apiUrl: cfg.apiUrl,
    apiInternalToken: cfg.apiInternalToken,
    natsUrl: cfg.natsUrl,
    agentImage: resolvedAgentImage,
    sidecarImage: cfg.sidecarImage,
    imagePullPolicy: cfg.imagePullPolicy,
    anthropicApiKey: cfg.anthropicApiKey,
    hostHomeDir: cfg.hostHomeDir,
    hostClaudeCredentialsFile: cfg.hostClaudeCredentialsFile,
    namespace: cfg.namespace,
    sessionCredentialsSecretName: credentialsSecretName,
    sessionHistoryConfigMapName: resumeHistoryConfigMapName ?? undefined,
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

/**
 * Zombie reaper. Walks every session still flagged `running` and
 * checks its Job's K8s status. If the Job succeeded or failed, flip
 * the session row — the NATS subscriber's status flip handles the
 * happy path, but a pod that crashed before it could emit
 * session.completed would otherwise sit as `running` forever.
 *
 * If we reap a session that never got a terminal event, we append
 * a synthetic `session.failed` event so the UI has something
 * coherent to show — the event log is the source of truth for "what
 * happened", sessions.status is a projection.
 */
async function reconcileRunning(
  cfg: JobWatcherConfig,
  batchApi: k8s.BatchV1Api,
): Promise<void> {
  const rows = await cfg.sql<{ id: string }[]>`
    SELECT id FROM sessions WHERE status = 'running'
    ORDER BY triggered_at ASC
    LIMIT 50
  `;
  if (rows.length === 0) return;

  const jobList = await batchApi
    .listNamespacedJob({
      namespace: cfg.namespace,
      labelSelector: "component=agent-session",
    })
    .catch((err) => {
      console.warn(
        `[jobs] list jobs for reconcile failed: ${(err as Error).message}`,
      );
      return null;
    });
  if (!jobList) return;

  const byId = new Map<string, k8s.V1Job>();
  for (const job of jobList.items) {
    const sid = job.metadata?.labels?.["session-id"];
    if (sid) byId.set(sid, job);
  }

  for (const row of rows) {
    // Before poking K8s, look for a terminal event on the row. The
    // NATS subscriber flips status on terminal events, but a session
    // that landed before the subscriber flip shipped (or a row the
    // subscriber missed during a reconnect) may have a
    // session.completed event without the matching status flip. Honor
    // the event as the truth.
    const priorTerminal = await cfg.sql<
      { type: string; payload: unknown }[]
    >`
      SELECT type, payload FROM session_events
      WHERE session_id = ${row.id}
        AND type IN ('session.completed', 'session.failed')
      ORDER BY seq DESC LIMIT 1
    `;
    if (priorTerminal.length > 0) {
      const ev = priorTerminal[0]!;
      const payload = (ev.payload ?? {}) as { error?: string };
      await markTerminal(
        cfg,
        row.id,
        ev.type === "session.completed",
        payload.error ? String(payload.error) : null,
      );
      continue;
    }

    const job = byId.get(row.id);
    if (!job) {
      // No Job and no terminal event. Either TTL cleanup already ran
      // on an old session (before this fix shipped), or the pod
      // crashed without emitting anything. Flag as failed so the row
      // doesn't hang.
      await markTerminal(cfg, row.id, false, "job disappeared");
      continue;
    }
    const status = job.status ?? {};
    if ((status.succeeded ?? 0) >= 1) {
      await markTerminal(cfg, row.id, true, null);
    } else if (
      (status.failed ?? 0) > 0 ||
      status.conditions?.some((c) => c.type === "Failed" && c.status === "True")
    ) {
      const failureReason =
        status.conditions?.find((c) => c.type === "Failed")?.message ??
        "job failed";
      await markTerminal(cfg, row.id, false, failureReason);
    }
    // else: Job is still running; leave the row as 'running'.
  }
}

async function markTerminal(
  cfg: JobWatcherConfig,
  sessionId: string,
  success: boolean,
  errorMessage: string | null,
): Promise<void> {
  // Re-check status first — the NATS subscriber may have already
  // flipped it to complete/failed milliseconds before we did.
  const session = await cfg.sessions.findById(sessionId as SessionId);
  if (!session || session.status === "complete" || session.status === "failed") {
    return;
  }
  await cfg.sessions.updateStatus(sessionId as SessionId, {
    status: success ? "complete" : "failed",
    completedAt: new Date(),
    errorMessage,
  });
  console.log(
    `[jobs] reaped session ${sessionId} as ${success ? "complete" : "failed"}${errorMessage ? `: ${errorMessage}` : ""}`,
  );
}

// Export used by unit tests to avoid hitting a real cluster.
export const _testing = { launchSession };

/**
 * For each installed shared-agent-resource in the session's workspace,
 * mint a per-branch credential against the session's primary repo and
 * branch, then write a per-session K8s Secret keyed as env vars
 * (DATABASE_URL, ...). Returns the Secret name and a system-prompt
 * append describing what the agent now has access to.
 *
 * When no shared resources are installed, or no minter is wired, this
 * returns an empty result — the session pod boots exactly as it did
 * before the feature.
 */
async function mintSessionCredentials(
  cfg: JobWatcherConfig,
  kc: k8s.KubeConfig,
  sessionId: string,
  workspaceId: string,
  repos: LinkedRepoForPod[],
): Promise<{
  credentialsSecretName: string | undefined;
  promptAppend: string;
}> {
  if (!cfg.sharedResources) {
    return { credentialsSecretName: undefined, promptAppend: "" };
  }
  const primary = repos[0];
  if (!primary) {
    // No repo linked = nothing to scope a branch database to. Skip the
    // mint entirely; the agent boots without DATABASE_URL.
    return { credentialsSecretName: undefined, promptAppend: "" };
  }
  const resources = await cfg.sharedResources.listByWorkspace(
    workspaceId as never,
  );
  const running = resources.filter(
    (r: SharedResource) => r.status === "running",
  );
  if (running.length === 0) {
    return { credentialsSecretName: undefined, promptAppend: "" };
  }

  const credsEnv: Record<string, string> = {};
  const haveKinds: string[] = [];

  for (const resource of running) {
    if (resource.kind === "postgres" && cfg.postgresMinter && cfg.postgresBranches) {
      try {
        const cred = await mintPostgresBranchCredential(
          cfg.postgresMinter,
          cfg.postgresBranches,
          {
            resource,
            namespace: cfg.namespace,
            repoFullName: primary.repo_full_name,
            branchName: primary.branch,
          },
        );
        credsEnv.DATABASE_URL = cred.dsn;
        haveKinds.push("postgres");
      } catch (err) {
        console.warn(
          `[jobs] postgres mint failed for session ${sessionId}: ${(err as Error).message}`,
        );
      }
    }
    if (resource.kind === "redis" && cfg.redisMinter && cfg.redisBranches) {
      try {
        const cred = await mintRedisBranchCredential(
          cfg.redisMinter,
          cfg.redisBranches,
          {
            resource,
            namespace: cfg.namespace,
            repoFullName: primary.repo_full_name,
            branchName: primary.branch,
          },
        );
        credsEnv.REDIS_URL = cred.url;
        haveKinds.push("redis");
      } catch (err) {
        console.warn(
          `[jobs] redis mint failed for session ${sessionId}: ${(err as Error).message}`,
        );
      }
    }
  }

  if (Object.keys(credsEnv).length === 0) {
    return { credentialsSecretName: undefined, promptAppend: "" };
  }

  const secretName = `x1-session-creds-${shortId(sessionId)}`;
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const body: k8s.V1Secret = {
    metadata: {
      name: secretName,
      namespace: cfg.namespace,
      labels: {
        app: "x1agent",
        component: "session-credentials",
        "session-id": sessionId,
      },
    },
    type: "Opaque",
    stringData: credsEnv,
  };
  try {
    await coreApi.createNamespacedSecret({ namespace: cfg.namespace, body });
  } catch (err) {
    if ((err as { code?: number }).code === 409) {
      await coreApi.replaceNamespacedSecret({
        name: secretName,
        namespace: cfg.namespace,
        body,
      });
    } else {
      throw err;
    }
  }

  return {
    credentialsSecretName: secretName,
    promptAppend: buildPromptAppend(haveKinds, primary.branch),
  };
}

function buildPromptAppend(kinds: string[], branchName: string): string {
  const lines: string[] = [];
  lines.push("## Shared agent resources");
  lines.push("");
  if (kinds.includes("postgres")) {
    lines.push(
      `You have a Postgres database at \`$DATABASE_URL\`. It is scoped to branch \`${branchName}\`. Migrations, schemas, fixtures, and any other state you create persist across sessions on this branch. On branch deletion the database is dropped.`,
    );
  }
  if (kinds.includes("redis")) {
    lines.push("");
    lines.push(
      `You have a Redis cache at \`$REDIS_URL\`. All keys are prefixed automatically by your branch scope; you read and write unprefixed keys and the server enforces isolation.`,
    );
  }
  return lines.join("\n");
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 12);
}

/**
 * When the pending session has `resumedFromSessionId` set, walk the
 * chain and render a markdown history file into a session-scoped
 * ConfigMap. Returns the ConfigMap name (or null if nothing to do /
 * the events repo isn't wired).
 *
 * The ConfigMap has a single key `session_history.md`; pod-spec
 * mounts it at `/workspace/session_history.md` via subPath.
 */
async function maybeBuildResumeHistoryConfigMap(
  cfg: JobWatcherConfig,
  kc: k8s.KubeConfig,
  session: SessionEntity,
): Promise<string | null> {
  if (!session.resumedFromSessionId) return null;
  if (!cfg.sessionEvents) return null;

  // Walk the chain root-first using the sessions repo.
  const loader = async (id: SessionEntity["id"]) => {
    return (await cfg.sessions.findById(id)) ?? null;
  };
  const chain = await walkResumeChain(
    await (async () => {
      const original = await cfg.sessions.findById(
        session.resumedFromSessionId!,
      );
      return original;
    })() as SessionEntity,
    loader,
  );
  if (chain.length === 0) return null;

  // Fetch events for every session in the chain.
  const eventsBySessionId = new Map<
    SessionEntity["id"],
    readonly SessionEventEntity[]
  >();
  for (const s of chain) {
    const evs = await cfg.sessionEvents.listBySession(s.id, { limit: 5000 });
    eventsBySessionId.set(s.id, evs);
  }

  const markdown = buildSessionHistory(chain, eventsBySessionId);
  const name = `x1-session-history-${shortId(session.id)}`;

  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const body: k8s.V1ConfigMap = {
    metadata: {
      name,
      namespace: cfg.namespace,
      labels: {
        app: "x1agent",
        component: "session-history",
        "session-id": session.id,
      },
    },
    data: {
      "session_history.md": markdown,
    },
  };
  try {
    await coreApi.createNamespacedConfigMap({
      namespace: cfg.namespace,
      body,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 409) {
      await coreApi.replaceNamespacedConfigMap({
        name,
        namespace: cfg.namespace,
        body,
      });
    } else {
      throw err;
    }
  }
  return name;
}
