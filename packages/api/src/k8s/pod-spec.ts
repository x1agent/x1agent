import type { V1Job } from "@kubernetes/client-node";

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
   * at /root so Claude Code picks up settings/agents/etc. Expected
   * form: `/Users/alice`.
   */
  /**
   * Dev-only: absolute host path to a file in Linux credentials format
   */
  /** K8s namespace the Job lives in. */
  namespace: string;
}

/**
 * Build the V1Job manifest for a session pod. Keeps the generation pure
 * so the watcher's DB + K8s code is testable; no K8s client references
 * here.
 */
export function buildSessionJob(spec: SessionPodSpec): V1Job {
  const jobName = `x1-session-${shortId(spec.sessionId)}`;
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
      activeDeadlineSeconds: 3600,
      backoffLimit: 0,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          securityContext: {
            // fsGroup owns the /workspace emptyDir so both containers
            // (agent as uid 1000, sidecar as root) can read/write.
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [
            { name: "workspace", emptyDir: {} },
            // NATS mTLS material — only the sidecar mounts this. The
            // agent container has no NATS cert and no way to pick one
            // up, so any direct NATS connect from the agent container
            // fails the TLS handshake.
            { name: "nats-tls", secret: { secretName: "nats-tls" } },
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
              securityContext: {
                // Claude Code refuses --dangerously-skip-permissions as
                // root, so the agent runs as the Dockerfile's uid 1000.
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                // The agent writes to /workspace (emptyDir) and to
                // /home/node/.claude (hostPath in dev). Both are
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
                  ? [
                      {
                        mountPath: "/home/node/.claude",
                      },
                      {
                        mountPath: "/home/node/.claude.json",
                      },
                    ]
                  : []),
                  ? [
                      {
                      },
                    ]
                  : []),
              ],
              resources: {
                requests: { memory: "1Gi", cpu: "500m" },
                limits: { memory: "2Gi", cpu: "1" },
              },
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
                // Sidecar still runs as root (alpine image default)
                // because git wants to chown /workspace contents to
                // uid 1000 to match the agent. Switching the sidecar
                // image to a dedicated non-root user is a follow-up.
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
