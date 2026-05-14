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
  /**
   * When false, the sidecar's credential helper refuses to hand out
   * git credentials for this repo. `git push` and credential-helper-
   * driven `git fetch` both fail; the agent can still read, edit, and
   * commit locally. See docs/security/repo-access.md.
   */
  allow_push: boolean;
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

/**
 * One Zone-3 remote_oauth MCP attachment, after the api has resolved
 * the active user's bearer and minted a per-MCP per-session K8s Secret.
 */
export interface RemoteOAuthAttachmentForPod {
  /** Catalog name — used as the mcpServers key + tool prefix. */
  catalogName: string;
  /** Upstream MCP URL the proxy forwards to (e.g. https://mcp.notion.com/mcp). */
  upstreamUrl: string;
  /** Local port the proxy listens on. Each attachment gets a unique port. */
  port: number;
  /** Name of the per-MCP K8s Secret containing key MCP_PROXY_BEARER. */
  bearerSecretName: string;
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
  /**
   * The user whose stored OAuth tokens this session acts as. For
   * user-triggered sessions this is the user who triggered. For
   * scheduler / orchestrator wakes, this is the agent's owner.
   * Sidecar attaches this to provider→external-API calls so the
   *
   * Optional for back-compat: pre-Phase-1 sessions don't set it; the
   * sidecar's provider-bridge routes return permission_required
   * cleanly when the env is missing.
   */
  triggeringUserId?: string;
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
   * Override for the Claude Code SDK's default model. When unset, the
   * SDK picks its own default — which on Vertex installs may resolve
   * to a model the operator's CLOUD_ML_REGION hasn't received yet.
   */
  anthropicModel?: string;
  /**
   * Anthropic credential source for the agent runtime. "vertex" makes
   * the SDK call Claude through Google Vertex AI using Workload
   * Identity (no key file in the pod); "api_key" uses the direct
   * Anthropic API and reads `anthropicApiKey` from env. Defaults to
   * "api_key" so existing local-dev paths (which don't set this)
   * keep working.
   */
  anthropicProvider?: "api_key" | "vertex";
  /** Required when anthropicProvider === "vertex". E.g. "us-east5". */
  vertexRegion?: string;
  /** Required when anthropicProvider === "vertex". GCP project hosting Vertex models. */
  vertexProjectId?: string;
  /**
   * K8s ServiceAccount the session pod runs as. When using Vertex,
   * this SA must be annotated with the GSA Workload Identity binding
   * (`iam.gke.io/gcp-service-account=...`). The Helm chart's
   * session-sa.yaml creates the SA + annotation; the api just needs
   * to set the name on the Job's pod spec.
   */
  serviceAccountName?: string;
  /**
   * K8s Secret holding the NATS client cert + key the sidecar uses for
   * mTLS. Default "nats-tls" matches the local-dev bootstrap script's
   * Secret which already has files named ca.crt / client.crt / client.key.
   *
   * When set to "nats-session-client-tls" (the prod chart's
   * cert-manager-issued Secret), pod-spec applies a Secret items
   * projection that renames tls.crt → client.crt and tls.key →
   * client.key so the sidecar's existing /etc/nats-tls/{ca,client}.{crt,key}
   * paths keep working without code changes.
   */
  natsClientTlsSecret?: string;
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
   * Account-level git identity for worker commits (X1A-42). When set,
   * pod-spec injects GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL /
   * GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL into the agent container's
   * env so commits attribute to the human who triggered the session
   * rather than the platform's GitHub App push principal
   * (`x1agent[bot]`). Resolved by the job-watcher from the triggering
   * user's stored identity at session-launch.
   *
   * Leave undefined when the user has no identity set; the env vars
   * are simply not emitted and git falls back to its `user.name` /
   * `user.email` config defaults — preserving the prior "x1agent[bot]"
   * attribution path with zero regression for users who haven't opted
   * in yet.
   */
  gitIdentity?: { name: string; email: string };
  /**
   * Image ref for the per-attachment OAuth proxy sibling container.
   * One container is added per remote_oauth attachment (Zone 3); each
   * holds a per-user bearer in its own env (mounted via
   * valueFrom.secretKeyRef) and forwards the agent's localhost
   * requests to the upstream MCP URL with Authorization injected.
   * The agent only sees a localhost URL with no headers — bearers
   * never enter the agent container.
   *
   * When omitted, no proxy containers are emitted (back-compat for
   * sessions with no remote_oauth attachments).
   */
  mcpOAuthProxyImage?: string;
  remoteOAuthAttachments?: RemoteOAuthAttachmentForPod[];
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
    ...(spec.triggeringUserId
      ? [{ name: "TRIGGERING_USER_ID", value: spec.triggeringUserId }]
      : []),
    { name: "AGENT_PROMPT", value: spec.agentPrompt },
    { name: "MAX_TURNS", value: String(spec.maxTurns) },
    { name: "SESSION_MODE", value: spec.sessionMode },
    { name: "IDLE_TIMEOUT_MS", value: String(spec.idleTimeoutMs) },
    { name: "SIDECAR_URL", value: "http://localhost:9090" },
    // API_URL stays on the agent container so the SDK / tooling can
    // construct absolute URLs back to the platform if needed. Crucially,
    // API_INTERNAL_TOKEN is NOT here: that token authorises every
    // /api/internal/* route (git-credential, user-oauth-token, spawn,
    // inject, uploads/raw, …) for any user in the install. Putting it
    // in the agent container collapsed the documented trust boundary
    // — the agent container is untrusted; the sidecar is the trust
    // boundary and holds the master credential. The one legitimate
    // agent → api call (X1A-96 image-upload reads) is now relayed
    // through the sidecar's /uploads/read route, exactly like git
    // creds and OAuth tokens. See packages/sidecar/src/uploads.rs.
    { name: "API_URL", value: spec.apiUrl },
    { name: "WORKSPACE_NAME", value: spec.workspaceName },
    { name: "WORKSPACE_SYSTEM_PROMPT", value: spec.systemPromptText },
    { name: "PLATFORM_NAME", value: "x1agent" },
    { name: "WORKSPACE_DIR", value: "/workspace" },
    // Surface Claude Code stderr to the pod log so we can see auth /
    // spawn failures. Dev-only.
    { name: "DEBUG_CLAUDE_AGENT_SDK", value: "true" },
    ...(spec.anthropicProvider === "vertex"
      ? [
          // Vertex path: Workload Identity supplies auth; the SDK reads
          // these to route through Google Vertex instead of api.anthropic.com.
          { name: "CLAUDE_CODE_USE_VERTEX", value: "1" },
          { name: "CLOUD_ML_REGION", value: spec.vertexRegion ?? "us-east5" },
          ...(spec.vertexProjectId
            ? [
                {
                  name: "ANTHROPIC_VERTEX_PROJECT_ID",
                  value: spec.vertexProjectId,
                },
              ]
            : []),
        ]
      : spec.anthropicApiKey
        ? [{ name: "ANTHROPIC_API_KEY", value: spec.anthropicApiKey }]
        : []),
    // Override the SDK's default model. Vertex installs need a model
    // identifier that Anthropic has actually rolled out to the
    // CLOUD_ML_REGION (the SDK's default may be ahead of Vertex). The
    // api reads ANTHROPIC_MODEL env at boot and propagates here so a
    // helm value flip rolls out cluster-wide. Per-agent overrides
    // come later via the agent.model column.
    ...(spec.anthropicModel
      ? [{ name: "ANTHROPIC_MODEL", value: spec.anthropicModel }]
      : []),
    // Account-level git identity (X1A-42). When the triggering user
    // has filled in their account-page form, the four standard git
    // env vars land here. git(1) honors GIT_AUTHOR_* / GIT_COMMITTER_*
    // ahead of repo / global config, so this overrides whatever
    // identity the agent image's git config might have. When the
    // user hasn't set an identity, all four are omitted and the
    // existing "x1agent[bot]" fallback path stands.
    ...(spec.gitIdentity
      ? [
          { name: "GIT_AUTHOR_NAME", value: spec.gitIdentity.name },
          { name: "GIT_AUTHOR_EMAIL", value: spec.gitIdentity.email },
          { name: "GIT_COMMITTER_NAME", value: spec.gitIdentity.name },
          { name: "GIT_COMMITTER_EMAIL", value: spec.gitIdentity.email },
        ]
      : []),
    // Zone-3 remote_oauth attachments. Agent reads this JSON and adds
    // each entry to its mcpServers map as { type: "http", url: localhost }.
    // No bearer here — the proxy holds it.
    ...(spec.remoteOAuthAttachments && spec.remoteOAuthAttachments.length > 0
      ? [
          {
            name: "MCP_REMOTE_ATTACHMENTS_JSON",
            value: JSON.stringify(
              spec.remoteOAuthAttachments.map((a) => ({
                name: a.catalogName,
                url: `http://127.0.0.1:${a.port}`,
              })),
            ),
          },
        ]
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
    ...(spec.triggeringUserId
      ? [{ name: "TRIGGERING_USER_ID", value: spec.triggeringUserId }]
      : []),
    { name: "AGENT_REPOS_JSON", value: JSON.stringify(spec.repos) },
    {
      name: "AGENT_COLLECTIONS_JSON",
      value: JSON.stringify(spec.collections),
    },
    // Wave 1 of the JetStream cutover (rfcs/jetstream-migration.md).
    // The control point is the api process so a single env flip rolls
    // every subsequent pod over without touching the chart per-pod.
    // Both flags are propagated, not re-read from the pod's own env,
    // so api↔sidecar agree on which path is in use:
    //
    //   USE_JETSTREAM_PUBLISH — sidecar publishes wakes via JetStream
    //                           when an orchestrator's `inject_message`
    //                           MCP tool routes through its sidecar
    //                           into a child's input subject. Without
    //                           this, the api side of Wave 1 is durable
    //                           but the sidecar side leaves a wake-loss
    //                           hole on orchestrator → child spawn.
    //   USE_JETSTREAM_CONSUME — sidecar reads its own session's input
    //                           subject as a durable JetStream consumer.
    ...(process.env.USE_JETSTREAM_PUBLISH === "true"
      ? [{ name: "USE_JETSTREAM_PUBLISH", value: "true" }]
      : []),
    ...(process.env.USE_JETSTREAM_CONSUME === "true"
      ? [{ name: "USE_JETSTREAM_CONSUME", value: "true" }]
      : []),
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
          // SA the agent pod impersonates via Workload Identity when
          // using Vertex. The Helm chart creates this SA with the
          // appropriate iam.gke.io/gcp-service-account annotation.
          // Local dev (no spec.serviceAccountName) falls through to
          // the namespace's `default` SA — same behavior as before.
          ...(spec.serviceAccountName
            ? { serviceAccountName: spec.serviceAccountName }
            : {}),
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
            //
            // Secret name varies by environment: "nats-tls" in local
            // dev (bootstrap script populates ca.crt/client.crt/client.key
            // directly), or the prod chart's cert-manager-issued
            // "nats-session-client-tls" (ca.crt / tls.crt / tls.key) —
            // remap tls.* → client.* so /etc/nats-tls paths the sidecar
            // reads stay constant.
            (() => {
              const name = spec.natsClientTlsSecret ?? "nats-tls";
              const isCertManagerFormat = name !== "nats-tls";
              return {
                name: "nats-tls",
                secret: isCertManagerFormat
                  ? {
                      secretName: name,
                      items: [
                        { key: "ca.crt", path: "ca.crt" },
                        { key: "tls.crt", path: "client.crt" },
                        { key: "tls.key", path: "client.key" },
                      ],
                    }
                  : { secretName: name },
              };
            })(),
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
            // Zone-3 OAuth-proxy sibling containers. One per attached
            // remote_oauth MCP. Each holds the user's bearer in its
            // own env (mounted via valueFrom.secretKeyRef from a
            // per-MCP K8s Secret minted by the job-watcher). Agent
            // talks to localhost:<port>; agent never sees the bearer.
            ...((spec.remoteOAuthAttachments ?? []).map((att) => ({
              name: `mcp-${att.catalogName}`.slice(0, 63),
              image: spec.mcpOAuthProxyImage ?? "x1agent-mcp-oauth-proxy:latest",
              imagePullPolicy,
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                readOnlyRootFilesystem: true,
              },
              env: [
                { name: "MCP_PROXY_NAME", value: att.catalogName },
                { name: "MCP_PROXY_TARGET", value: att.upstreamUrl },
                { name: "MCP_PROXY_PORT", value: String(att.port) },
                {
                  name: "MCP_PROXY_BEARER",
                  valueFrom: {
                    secretKeyRef: {
                      name: att.bearerSecretName,
                      key: "MCP_PROXY_BEARER",
                    },
                  },
                },
              ],
              ports: [{ containerPort: att.port }],
              resources: {
                requests: { memory: "32Mi", cpu: "10m" },
                limits: { memory: "128Mi", cpu: "200m" },
              },
              readinessProbe: {
                httpGet: { path: "/healthz", port: att.port },
                initialDelaySeconds: 1,
                periodSeconds: 5,
              },
            }))),
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
