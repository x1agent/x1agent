import type { V1Job } from "@kubernetes/client-node";

/**
 * Agent kind — mirrors `agents.kind` in the DB. Pod-spec branches on
 * this value: orchestrators get no hard deadline, OnFailure restart,
 * a PVC-backed workspace, and smaller resource requests (they spend
 * most wall-clock time idle). Workers and scheduled agents share the
 * disposable pod shape. See docs/architecture/orchestration.md §
 * Pod-shape by kind.
 */
export type AgentKind = "worker" | "orchestrator" | "scheduled";

export interface LinkedRepoForPod {
  repo_full_name: string;
  branch: string;
  mount_path: string;
  auto_push: boolean;
  installation_id: number;
}

export interface AttachedCollectionForPod {
  id: string;
  slug: string;
  /** Provider-opaque backing-store id the adapter uses in NATS calls. */
  backend_handle: string;
  /** "surrealdb" | future providers. */
  provider_type: string;
  is_default: boolean;
}

export interface SessionPodSpec {
  sessionId: string;
  agentId: string;
  agentSlug: string;
  /**
   * Discriminator from `agents.kind`. Drives activeDeadlineSeconds,
   * restartPolicy, backoffLimit, resource requests, and the workspace
   * volume type (emptyDir vs PVC). See AgentKind above.
   */
  agentKind: AgentKind;
  workspaceSlug: string;
  workspaceName: string;
  agentPrompt: string;
  systemPromptText: string;
  heartbeatMd: string;
  sessionMode: "interactive" | "oneshot";
  idleTimeoutMs: number;
  maxTurns: number;
  repos: LinkedRepoForPod[];
  collections: AttachedCollectionForPod[];
  /** Cluster-internal api URL. `http://api:30001` on dev. */
  apiUrl: string;
  /** Shared secret the sidecar sends as X-Internal-Token. */
  apiInternalToken: string;
  /** Cluster-internal NATS URL. `nats://nats:4222` on dev. */
  natsUrl: string;
  agentImage: string;
  sidecarImage: string;
  imagePullPolicy?: "IfNotPresent" | "Always" | "Never";
  anthropicApiKey?: string;
  /**
   * Dev-only: host path to `~/.claude` (directory) and `~/.claude.json`
   * (file). When set, both are hostPath-mounted into the agent container
   * at /home/agent so Claude Code picks up settings/agents/etc. Expected
   * form: `/Users/alice`.
   */
  /**
   * Dev-only: absolute host path to a file in Linux credentials format
   */
  /** K8s namespace the Job lives in. */
  namespace: string;
  /**
   * Name of a K8s Secret (in the same namespace) holding per-session
   * credentials for shared-agent-resources — DATABASE_URL, REDIS_URL,
   * etc. Injected into the agent container via `envFrom.secretRef` so
   * the agent sees standard env vars without the values ever landing in
   * the pod spec.
   */
  sessionCredentialsSecretName?: string;
  /**
   * Name of a K8s ConfigMap carrying the rendered session-history
   * markdown for a resumed session. When set, pod-spec mounts the
   * `session_history.md` key at `/workspace/session_history.md` so
   * the agent can read prior context before handling the next user
   * message. See SESSION_RESUME_PROMPT in @x1agent/domain-sessions.
   */
  sessionHistoryConfigMapName?: string;
}

/**
 * Build the V1Job manifest for a session pod. Keeps the generation pure
 * so the watcher's DB + K8s code is testable; no K8s client references
 * here.
 */
export function buildSessionJob(spec: SessionPodSpec): V1Job {
  const jobName = sessionJobName(spec.sessionId);
  const imagePullPolicy = spec.imagePullPolicy ?? "IfNotPresent";
  const labels = {
    app: "x1agent",
    component: "agent-session",
    "session-id": spec.sessionId,
    "agent-id": spec.agentId,
    "workspace-slug": spec.workspaceSlug,
  };

  const agentEnv = [
    { name: "SESSION_ID", value: spec.sessionId },
    { name: "AGENT_ID", value: spec.agentId },
    { name: "AGENT_PROMPT", value: spec.agentPrompt },
    { name: "MAX_TURNS", value: String(spec.maxTurns) },
    { name: "SESSION_MODE", value: spec.sessionMode },
    { name: "IDLE_TIMEOUT_MS", value: String(spec.idleTimeoutMs) },
    { name: "SIDECAR_URL", value: "http://localhost:9090" },
    { name: "WORKSPACE_NAME", value: spec.workspaceName },
    { name: "WORKSPACE_SYSTEM_PROMPT", value: spec.systemPromptText },
    { name: "PLATFORM_NAME", value: "x1agent" },
    { name: "WORKSPACE_DIR", value: "/workspace" },
    // Surface Claude Code stderr to the pod log so we can see auth /
    // spawn failures. Dev-only.
    { name: "DEBUG_CLAUDE_AGENT_SDK", value: "true" },
    ...(spec.anthropicApiKey
      ? [{ name: "ANTHROPIC_API_KEY", value: spec.anthropicApiKey }]
      : []),
  ];

  const sidecarEnv = [
    { name: "SESSION_ID", value: spec.sessionId },
    { name: "NATS_URL", value: spec.natsUrl },
    // mTLS to NATS — sidecar mounts the shared `nats-tls` Secret at
    // /etc/nats-tls; agent container deliberately does not.
    { name: "NATS_CA_FILE", value: "/etc/nats-tls/ca.crt" },
    { name: "NATS_CLIENT_CERT", value: "/etc/nats-tls/client.crt" },
    { name: "NATS_CLIENT_KEY", value: "/etc/nats-tls/client.key" },
    { name: "AGENT_STREAM_URL", value: "http://localhost:3100" },
    { name: "CHANNEL_URL", value: "http://localhost:8788" },
    { name: "API_URL", value: spec.apiUrl },
    { name: "API_INTERNAL_TOKEN", value: spec.apiInternalToken },
    { name: "AGENT_ID", value: spec.agentId },
    { name: "SESSION_WORKSPACE_SLUG", value: spec.workspaceSlug },
    { name: "AGENT_REPOS_JSON", value: JSON.stringify(spec.repos) },
    {
      name: "AGENT_COLLECTIONS_JSON",
      value: JSON.stringify(spec.collections),
    },
  ];

  // Pod-shape branching by agent kind. Orchestrators are long-lived
  // singletons that spend most of their time blocked on NATS waiting
  // for a child signal or a user message; they get no hard deadline,
  // OnFailure restart, a PVC-backed workspace (so the SDK transcript
  // survives pod restarts and the agent can `resume: SESSION_ID` on
  // re-entry), and smaller resource requests. Workers and scheduled
  // agents get the disposable shape. See
  // docs/architecture/orchestration.md § Pod-shape by kind.
  const isOrchestrator = spec.agentKind === "orchestrator";
  // PVC name matches the jobName exactly — the Job watcher creates a
  // PVC under this name before creating the Job, so the scheduler can
  // bind it immediately. Keep the names coupled so the reaper can
  // find the PVC from a known Job name.
  const pvcName = jobName;
  const workspaceVolume = isOrchestrator
    ? {
        name: "workspace",
        persistentVolumeClaim: { claimName: pvcName },
      }
    : { name: "workspace", emptyDir: {} };
  const agentResources = isOrchestrator
    ? {
        requests: { memory: "512Mi", cpu: "50m" },
        limits: { memory: "2Gi", cpu: "1" },
      }
    : {
        requests: { memory: "1Gi", cpu: "500m" },
        limits: { memory: "2Gi", cpu: "1" },
      };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: spec.namespace,
      labels,
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      // Orchestrators intentionally have no hard deadline — they're
      // meant to live for days. Workers cap at 1h as a runaway-loop
      // guard. Keep backoffLimit paired: orchestrators retry on crash
      // (OnFailure + backoffLimit 6), workers fail fast.
      ...(isOrchestrator ? {} : { activeDeadlineSeconds: 3600 }),
      backoffLimit: isOrchestrator ? 6 : 0,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: isOrchestrator ? "OnFailure" : "Never",
          securityContext: {
            // fsGroup owns the /workspace emptyDir so both containers
            // (agent as uid 1000, sidecar as root) can read/write.
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [
            workspaceVolume,
            // NATS mTLS material — only the sidecar mounts this. The
            // agent container has no NATS cert and no way to pick one
            // up, so any direct NATS connect from the agent container
            // fails the TLS handshake.
            { name: "nats-tls", secret: { secretName: "nats-tls" } },
            ...(spec.sessionHistoryConfigMapName
              ? [
                  {
                    name: "session-history",
                    configMap: {
                      name: spec.sessionHistoryConfigMapName,
                    },
                  },
                ]
              : []),
              ? [
                  {
                    hostPath: {
                      type: "DirectoryOrCreate" as const,
                    },
                  },
                  {
                    hostPath: {
                      type: "FileOrCreate" as const,
                    },
                  },
                ]
              : []),
              ? [
                  {
                    hostPath: {
                      type: "File" as const,
                    },
                  },
                ]
              : []),
          ],
          containers: [
            {
              name: "agent",
              image: spec.agentImage,
              imagePullPolicy,
              envFrom: spec.sessionCredentialsSecretName
                ? [{ secretRef: { name: spec.sessionCredentialsSecretName } }]
                : undefined,
              securityContext: {
                // Claude Code refuses --dangerously-skip-permissions as
                // root, so the agent runs as the Dockerfile's uid 1000.
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                // The agent writes to /workspace (emptyDir) and to
                // /home/agent/.claude (hostPath in dev). Both are
                // mounted volumes; the rest of the FS can stay
                // read-only — Claude Code's caches that need writable
                // paths inside $HOME live under .claude already.
                // readOnlyRootFilesystem: true is being deferred —
                // Claude Code writes to a few host paths under
                // node_modules at startup and turning RO root on
                // requires audit + tmpfs mounts; tracked as a
                // follow-up.
              },
              env: agentEnv,
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                ...(spec.sessionHistoryConfigMapName
                  ? [
                      {
                        name: "session-history",
                        mountPath: "/workspace/session_history.md",
                        subPath: "session_history.md",
                        readOnly: true,
                      },
                    ]
                  : []),
                  ? [
                      {
                        mountPath: "/home/agent/.claude",
                      },
                      {
                        mountPath: "/home/agent/.claude.json",
                      },
                    ]
                  : []),
                  ? [
                      {
                      },
                    ]
                  : []),
              ],
              resources: agentResources,
              readinessProbe: {
                httpGet: { path: "/health", port: 3100 },
                initialDelaySeconds: 5,
                periodSeconds: 5,
              },
            },
            {
              name: "sidecar",
              image: spec.sidecarImage,
              imagePullPolicy,
              securityContext: {
                // Sidecar runs as the same uid as the agent (1000) so
                // files it writes into the shared /workspace volume
                // (notably: git clones at startup) are owned by an
                // id the agent can read AND write. Running as root
                // caused a silent perm bug: the chown-to-1000 attempt
                // failed because CAP_CHOWN was dropped, and the
                // agent had to re-clone repos to a writable location
                // as a workaround. Matching uids end-to-end removes
                // the workaround.
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              env: sidecarEnv,
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                {
                  name: "nats-tls",
                  mountPath: "/etc/nats-tls",
                  readOnly: true,
                },
              ],
              resources: {
                requests: { memory: "128Mi", cpu: "100m" },
                limits: { memory: "256Mi", cpu: "250m" },
              },
              readinessProbe: {
                httpGet: { path: "/health", port: 9090 },
                initialDelaySeconds: 3,
                periodSeconds: 5,
              },
            },
          ],
        },
      },
    },
  };
}

// First 8 chars of a UUID keep the label under the 63-char limit while
// staying readable — the full session_id is on the labels for joins.
function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 12);
}

/**
 * Job name == PVC name for orchestrator workspaces. Consumers that
 * need to create the PVC before the Job (so the scheduler can bind
 * it at Pod creation time) or find the PVC later for reaping can
 * derive the name from the session id the same way buildSessionJob
 * does.
 */
export function sessionJobName(sessionId: string): string {
  return `x1-session-${shortId(sessionId)}`;
}
