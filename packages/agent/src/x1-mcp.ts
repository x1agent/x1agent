/**
 * Internal MCP server — the built-in tools every x1agent session exposes
 * to Claude. When Claude calls one of these tools, the handler POSTs an
 * event to the sidecar on localhost:9090, which publishes it to NATS
 * for the session viewer in the browser.
 *
 * Tools:
 *   emit_status        — announce a phase of work
 *   emit_artifact      — show inline content (markdown, code, mermaid)
 *   request_input      — ask the user a question, wait for reply
 *   emit_error         — report a problem
 *   share              — publish a workspace file with rich rendering
 *   request_permission — ask the user to grant a scope
 *   end_session        — declare the session complete
 *
 * Runs as a stdio subprocess of the agent container.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";

async function postToSidecar(type: string, payload: unknown) {
  try {
    await fetch(`${sidecarUrl}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
  } catch (err) {
    console.error(
      `[x1-mcp] sidecar POST failed: ${(err as Error).message}`,
    );
  }
}

const server = new Server(
  { name: "x1agent", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "emit_status",
      description:
        "Announce the current phase of work to the user watching this session. Call this when you start a new stage, make meaningful progress, or hit something worth flagging.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: [
              "starting",
              "researching",
              "analyzing",
              "writing",
              "reviewing",
              "waiting",
              "done",
            ],
            description: "Current phase of work",
          },
          detail: {
            type: "string",
            description: "Short description of what you're doing",
          },
        },
        required: ["status"],
      },
    },
    {
      name: "emit_artifact",
      description:
        "Show inline content to the user in the session UI. For file-backed content (HTML, images, CSV, etc.), use the `share` tool instead.\n\nHow each type renders:\n- **code**: raw monospace text on dark background. Use ONLY for actual source code snippets.\n- **analysis**: rendered Markdown with headings, lists, tables, bold/italic.\n- **summary**: rendered Markdown. Use for executive summaries or conclusions.\n- **document**: rendered Markdown. Use for reports, Mermaid diagrams, or any formatted text.\n- **diff**: rendered Markdown. Use for showing changes.\n- **other**: rendered Markdown.\n\nIMPORTANT: If the content contains Markdown formatting (headings, tables, lists, Mermaid diagrams), use 'document' or 'analysis' — NOT 'code'. Only use 'code' for actual programming language source code.",
      inputSchema: {
        type: "object" as const,
        properties: {
          artifact_type: {
            type: "string",
            enum: [
              "code",
              "analysis",
              "summary",
              "document",
              "diff",
              "other",
            ],
          },
          title: { type: "string" },
          content: { type: "string" },
          language: {
            type: "string",
            description: "Programming language for code artifacts",
          },
          metadata: { type: "object" },
        },
        required: ["artifact_type", "title", "content"],
      },
    },
    {
      name: "request_input",
      description:
        "Ask the user a question. The answer arrives as a new user message with the same `request_id`. After calling this, either keep working on other parallel tasks or end the turn and wait.",
      inputSchema: {
        type: "object" as const,
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of clickable choices",
          },
          request_id: {
            type: "string",
            description: "Unique ID used to match the response",
          },
        },
        required: ["question", "request_id"],
      },
    },
    {
      name: "emit_error",
      description: "Report an error or problem to the user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: { type: "string" },
          recoverable: { type: "boolean" },
        },
        required: ["message", "recoverable"],
      },
    },
    {
      name: "share",
      description:
        "Share a file or folder from /workspace with the user. The content is uploaded to persistent storage and displayed inline in the session UI. Use this for any output the user should see or download.\n\nSupported types and how they render:\n- HTML (.html or folder with index.html) → interactive iframe. Relative CSS/JS/image refs work.\n- Images (.png, .jpg, .svg, .gif, .webp) → inline image preview\n- CSV (.csv) → interactive data table\n- JSON/JSONL (.json, .jsonl) → expandable JSON tree viewer\n- Markdown (.md) → rendered document\n- Code (.ts, .py, .rs, etc.) → syntax-highlighted code block\n- ZIP (.zip) → download link\n\nThe file must already exist at /workspace/{path} before calling share. Typical flow: write the file with the Write tool, then call share. Shares are persistent — they survive past the session and show up on the workspace Shares page.\n\n**Update mode** — when revising an artifact the user has commented on, pass the existing `share_id` so the same pill updates in place. The comment thread stays attached. NEVER create a fresh share for a v2 when v1 has comments — the comments would orphan onto the stale version. Use update mode for every iteration on a draft, mockup, doc, or report that already has a `share_comment_added` wake history.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to /workspace (e.g. 'output/report.html', 'charts/revenue.png', 'data.csv')",
          },
          title: {
            type: "string",
            description: "Short display title for the share card.",
          },
          share_id: {
            type: "string",
            description:
              "UPDATE MODE — when present, overwrites the existing share at this id with the new bytes. Same pill renders in place; comments stay attached. Use this whenever you're revising a share that has comments on it (you saw them via a `share_comment_added` wake). Omit to publish a brand-new share.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "read_share",
      description:
        "Read the content of a share THIS session previously published with the `share` tool. The share content lives in persistent storage (GCS in prod, /tmp in dev) and survives the pod, so resumed sessions can read back their own past output even after `/workspace` was wiped.\n\nSlice A (PRD 0006) scope: 200 only when the share belongs to THIS session. Reading another session's share returns 403 (Slice B will widen this once explicit grants ship); a share_id that doesn't exist anywhere returns 404.\n\nReturns `{ share_id, path?, mime_type, size, content_b64 }`. `content_b64` is always base64 because shares can be binary (PNG, PDF, ZIP). Decode locally before use.\n\nUse `path` only for multi-file shares (sites with assets); single-file shares (markdown, image, csv) take the default and don't need it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          share_id: {
            type: "string",
            description:
              "The id echoed back from a prior `share` call in this session.",
          },
          path: {
            type: "string",
            description:
              "Optional. For multi-file shares (sites with assets), the relative path inside the share — e.g. 'assets/main.css'. Omit for single-file shares.",
          },
        },
        required: ["share_id"],
      },
    },
    {
      name: "share_comment",
      description:
        "Post a comment on a share you (or another agent) previously published with the `share` tool. Symmetric to `share` — adds a thread (or replies to an existing one) on a markdown or HTML share so the user sees your follow-up alongside the artifact in the timeline pill or the fullscreen flyout.\n\n**Brevity is mandatory.** Comments are NOT chat. Reply in **one or two short sentences** — an acknowledgment, a clarifying question, a confirmation that you'll act, or a one-line note that you've shipped a revision. Anything longer than ~2 sentences belongs in chat or in a fresh share with the explanation rendered as the artifact. Operators scan comment threads inline next to the artifact; a paragraph buries the conversation. If you find yourself wanting to explain at length, the right move is `share(path=…, share_id=<existing>)` with the explanation as a markdown share, plus a one-line comment pointing at it.\n\nTwo modes:\n- **Reply to an existing thread:** pass `thread_id` only (plus `text`). The server resolves the thread → share and posts your reply as the next seq in that thread. Use this when the wake plumbing handed you a `thread_id` to respond to.\n- **Open a new thread:** pass `share_id` + `scope` (and `anchor` if scope=passage) + `text`. v1 commentable types are markdown (`document`) and HTML (`site`). For markdown you can anchor to a passage; for HTML threads are share-scoped only.\n\nIDOR is enforced server-side: a `thread_id` from a foreign workspace returns `403 thread_not_visible`. You cannot leak content by guessing ids.\n\nDoes NOT wake the producing agent on your own reply (anti-loop). Comments authored by users will wake the agent of the share via X1A-55.",
      inputSchema: {
        type: "object" as const,
        properties: {
          thread_id: {
            type: "string",
            description:
              "Reply mode: id of an existing thread (the wake event hands this to you). Mutually exclusive with share_id+scope.",
          },
          share_id: {
            type: "string",
            description:
              "New-thread mode: id of the share to comment on. Pair with `scope` (and `anchor` for passage scope).",
          },
          scope: {
            type: "string",
            enum: ["passage", "share"],
            description:
              "passage = anchored to a selection (markdown only). share = thread on the whole share (any commentable type).",
          },
          anchor: {
            type: "object",
            description:
              "Selection metadata for scope=passage. { selection: { start_line, start_col, end_line, end_col, quoted_text } }",
          },
          text: {
            type: "string",
            description: "Markdown body of the comment.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "share_comment_resolve",
      description:
        "Mark a comment thread as resolved. Same IDOR check as `share_comment` — a foreign thread_id returns `403 thread_not_visible`. Soft resolve, not delete — `share_comment_resolve` with `unresolve: true` reverses it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          thread_id: { type: "string" },
          unresolve: {
            type: "boolean",
            description: "true to reverse a previous resolve. Default false.",
          },
        },
        required: ["thread_id"],
      },
    },
    {
      name: "request_permission",
      description:
        "Ask the active user to grant a PLATFORM-INTERNAL permission scope (e.g. 'git.write', 'vector.write'). The user sees an in-app dialog and clicks Allow or Deny; a system message tells you the outcome.\n\n**Scope format is `domain.action` — short slugs, NOT URLs.** Example valid scopes: `git.write`, `vector.write`, `repo.attach`. Example INVALID scopes: any `https://...googleapis.com/...` URL, any Slack OAuth scope, any external-provider scope.\n\n**DO NOT call this for external-OAuth permission errors (Google Drive / Docs / Sheets / Gmail / Calendar, Slack, GitHub, Linear, etc.).** Those are user-OAuth scopes, granted by the user signing in to the provider directly with the right consent. If a Google Workspace or Slack or other external MCP call returns `permission_required` or a 403/401, the correct response is to **tell the user in plain English** that they need to (re)connect their account — point them at the workspace integrations page in the UI. Do NOT call request_permission. Do NOT retry the failed tool.\n\nUse this tool ONLY for x1agent-internal scopes the platform defines. When unsure, ask the user instead of guessing.\n\nAfter calling this, END YOUR TURN and wait — do not retry the gated operation immediately. When approved a synthetic user message starts a fresh turn. Write justifications from the user's perspective.",
      inputSchema: {
        type: "object" as const,
        properties: {
          scopes: {
            type: "array",
            items: { type: "string" },
          },
          justification: { type: "string" },
          requested_tool: { type: "string" },
          requested_args: { type: "object" },
        },
        required: ["scopes", "justification"],
      },
    },
    {
      name: "end_session",
      description:
        "End this session. Call this only when the user's task is complete and no follow-up is expected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
      },
    },
    {
      name: "list_collections",
      description:
        "List the knowledge collections this session can read and write. Returns [{id, slug, backend_handle, provider_type, is_default}]. The default is the write target for graph_write / vector_upsert when you don't pass an explicit `collection`.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "graph_query",
      description:
        "Run a read-only SurrealQL query against a collection. Pass `collection` as a slug ('ideas') or id; omit to hit the default. Returns the raw provider result under `result.rows`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          query: { type: "string" },
          vars: { type: "object" },
        },
        required: ["query"],
      },
    },
    {
      name: "graph_write",
      description:
        "Create a record in a collection with provenance automatically stamped (session + confidence + source + derived_from). `record_type` is a slug ('person', 'decision', or a new one the agent introduces). `data` is the record's fields; provenance goes to `_provenance` under the hood.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          record_type: { type: "string" },
          data: { type: "object" },
          confidence: {
            type: "number",
            description: "0..1 self-reported confidence in the fact. Default 1.",
          },
          source: {
            type: "string",
            description: "Free-form origin of the fact — URL, doc id, 'manual'.",
          },
          derived_from: {
            type: "array",
            items: { type: "string" },
            description: "Ids of other records this one came from.",
          },
        },
        required: ["record_type", "data"],
      },
    },
    {
      name: "graph_relate",
      description:
        "Create an edge between two existing records. `from` and `to` are record ids (the full 'table:hash' SurrealDB returns), `edge` is the label ('WORKS_ON', 'PART_OF').",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          from: { type: "string" },
          edge: { type: "string" },
          to: { type: "string" },
          properties: { type: "object" },
        },
        required: ["from", "edge", "to"],
      },
    },
    {
      name: "graph_resolve",
      description:
        "Look up a single record by fuzzy hints (name + email + attributes, OR-matched). Returns `null` if nothing matches. Use before graph_write to avoid duplicating a person / org you already recorded.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          record_type: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          attributes: { type: "object" },
        },
        required: ["record_type"],
      },
    },
    {
      name: "graph_discover",
      description:
        "List every record type registered in a collection — the default seed types plus any the agent introduced. Use before picking `record_type` for a write.",
      inputSchema: {
        type: "object" as const,
        properties: { collection: { type: "string" } },
      },
    },
    {
      name: "vector_upsert",
      description:
        "Write an embedding into a collection's vector store. `id` is caller-supplied and idempotent (re-upsert replaces). Vector dimension must match what the collection was provisioned with.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          id: { type: "string" },
          vector: { type: "array", items: { type: "number" } },
          metadata: { type: "object" },
        },
        required: ["id", "vector"],
      },
    },
    {
      name: "vector_search",
      description:
        "Top-K nearest-neighbour search. Returns [{id, score, metadata}] ranked so higher score = better match regardless of distance metric. `filter` is an AND of metadata equality predicates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          vector: { type: "array", items: { type: "number" } },
          top_k: { type: "number" },
          filter: { type: "object" },
        },
        required: ["vector"],
      },
    },
    {
      name: "vector_delete",
      description: "Remove a vector by caller-supplied id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          collection: { type: "string" },
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "post_message",
      description:
        "Send a message to a channel via the workspace's messaging provider (Slack, Teams, etc — set by platform config). Channel format depends on the provider — Slack accepts #channel, @user, or the raw Cxxxx id. Returns { ok, message_id, channel, posted_at } or { ok: false, error }. Common error codes: channel_not_found, messaging_unauthorized, messaging_provider_unreachable, provider_timeout.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description:
              "Channel id or alias (#ops, @alice, Cxxxx for Slack)",
          },
          text: { type: "string" },
          thread_id: {
            type: "string",
            description:
              "Optional thread reference (Slack thread_ts, Teams replyToId)",
          },
          username: {
            type: "string",
            description:
              "Optional display-name override where the provider supports it",
          },
        },
        required: ["channel", "text"],
      },
    },
    {
      name: "request_grant",
      description:
        "Ask the user to grant you a capability. One tool for every grant type — spawn, tool_scope, anything future. The user sees an inline Approve / Deny card in their session view; a message tells you the outcome.\n\nShape `details` to the grant_type:\n  - spawn: { child_agent_id: string }\n  - tool_scope: { scope: string }\n\nSet `scope` to:\n  - once: approve exactly one tool call\n  - session: approve for this session only\n  - persistent: standing approval (rare, admin-level)\n\nAfter calling this END YOUR TURN — the response arrives as a user message starting a fresh turn.",
      inputSchema: {
        type: "object" as const,
        properties: {
          request_id: {
            type: "string",
            description: "Unique ID used to match the response",
          },
          grant_type: {
            type: "string",
            enum: ["spawn", "tool_scope"],
          },
          details: {
            type: "object",
            description: "Type-specific payload (see tool description)",
          },
          scope: {
            type: "string",
            enum: ["once", "session", "persistent"],
          },
          justification: {
            type: "string",
            description:
              "One-sentence explanation of why you need this, from the user's perspective.",
          },
        },
        required: [
          "request_id",
          "grant_type",
          "details",
          "scope",
          "justification",
        ],
      },
    },
    {
      name: "list_spawnable_agents",
      description:
        "List the child agents this session is allowed to spawn. Returns [{id, slug, name}]. Empty list means the agent has no spawn grants — ask the user to grant one on the agent edit screen.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "read_child_output",
      description:
        "Read durable events from a session you spawned. Pass child_session_id (returned by spawn_session) and optionally after_seq to page — typical loop: call with after_seq=0 first, then pass back the last seq you saw. Returns { child: {id, status}, events: [{seq, type, payload, timestamp}] }. A 403 means the session isn't yours to read.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_session_id: { type: "string" },
          after_seq: {
            type: "number",
            description:
              "Return only events whose seq is greater than this. Default 0 (all).",
          },
          limit: {
            type: "number",
            description:
              "Max number of events (default 500, cap 5000).",
          },
        },
        required: ["child_session_id"],
      },
    },
    {
      name: "inject_message",
      description:
        "Send a user-message into a session you spawned. Use to drive a child agent — e.g. ask it a follow-up question after reading its output. The child receives it as a new user turn with from_session_id set to your id. Returns { ok, sequence }. A 403 means the session isn't yours to drive.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_session_id: { type: "string" },
          text: { type: "string" },
        },
        required: ["child_session_id", "text"],
      },
    },
    {
      name: "spawn_session",
      description:
        "Start a new session of a child agent. Pass the child_agent_id returned by list_spawnable_agents. Returns {session_id, status}. After spawning, you can watch the child's progress via read_child_output (coming soon) or simply continue with other work — the child runs in its own pod.\n\nOptionally pass `model` to override the Claude model the spawned session runs under — useful as a cost lever (`\"sonnet\"` for cheap routine work, `\"opus\"` for migrations / auth / tenant-isolation / cross-domain refactors). The platform admin curates the enabled-models allowlist at /admin/anthropic-models; passing a model that isn't enabled returns 403 model_not_enabled. Omitting `model` falls back to the child agent's configured `model`, then the deployment-wide ANTHROPIC_MODEL default.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_agent_id: {
            type: "string",
            description: "UUID of the child agent to spawn",
          },
          model: {
            type: "string",
            description:
              'Optional per-spawn Claude model override. Short names ("sonnet", "opus", "haiku") resolve against the deployment\'s enabled-models allowlist (the api picks the newest GA id whose base name matches); full model ids (e.g. "claude-sonnet-4-5@20250929") pass through verbatim and must appear in the allowlist as well. Omit to inherit the child agent\'s configured model.',
          },
        },
        required: ["child_agent_id"],
      },
    },
    {
      name: "cancel_session",
      description:
        "Cancel a child session you spawned. Use when the child has gone off-task, hit an unrecoverable error, or is no longer needed. Idempotent — a second cancel on the same child returns `cancelled: false` instead of erroring, so racing state-change wakes from the watchdog won't trip you up. The K8s Job backing the child is also deleted so the pod actually stops; without this a long-running stuck child keeps burning tokens. Returns `{ ok, cancelled, session: { id, status, completed_at } }`. A 403 means the session isn't yours to cancel (i.e. wasn't spawned by you). A 404 means the session id doesn't exist.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_session_id: {
            type: "string",
            description:
              "The session id returned by spawn_session — the child you want to terminate.",
          },
          reason: {
            type: "string",
            description:
              "Optional short note recorded on the session.cancelled_by_parent event. Helps the timeline reader understand why the orchestrator pulled the plug.",
          },
        },
        required: ["child_session_id"],
      },
    },
    {
      name: "share_to_child",
      description:
        "Snapshot a file or folder from THIS session's /workspace into a child session's /workspace at the named dest_path. Snapshot semantics ONLY — the child gets a copy of the bytes at the moment of the call; subsequent edits in this session do NOT propagate. A second call with the same source_path re-stages a fresh snapshot at the same dest. Use this to hand a child agent the artifacts it needs to work on — a generated spec, a CSV, a directory of code — without committing through git. Returns `{ ok, files, total_size }` on success. The child must already exist and have been spawned by you; a 403 means the session isn't yours.",
      inputSchema: {
        type: "object" as const,
        properties: {
          child_session_id: {
            type: "string",
            description: "The child session id (returned by spawn_session).",
          },
          source_path: {
            type: "string",
            description:
              "Path under /workspace to copy (file or directory). Same rules as the `share` tool — relative or `/workspace/...` accepted; `..` rejected.",
          },
          dest_path: {
            type: "string",
            description:
              "Optional destination path under the child's /workspace. Defaults to the source path's basename. Example: source_path='out/report.md', dest_path='inputs/report.md'.",
          },
        },
        required: ["child_session_id", "source_path"],
      },
    },
    {
      name: "preview_deploy",
      description:
        "Deploy the current branch of an attached repo to a preview environment. The platform reads `.x1agent/preview.yaml` at the root of the repo's checked-out tree at commit_sha, builds a Docker image via Kaniko, pushes it to the in-cluster registry, applies a Deployment + Service + Ingress, and returns the public URL. Blocks until the preview is reachable (usually 1–3 minutes). Returns { ok, url, slug, image } on success or { ok: false, code, message } on failure. The resulting URL is stable for the lifetime of the preview and is what humans will bookmark — prefer writing the URL into your session summary share.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo_full_name: {
            type: "string",
            description:
              "owner/repo of the attached repo to deploy (e.g. 'hirer-co/app').",
          },
          branch: {
            type: "string",
            description:
              "Branch name (e.g. 'feat/scaffold'). The provider clones this ref for the build.",
          },
          commit_sha: {
            type: "string",
            description:
              "Commit SHA to build. The provider tags the resulting image with a short form of this SHA so redeploys of the same sha are idempotent.",
          },
        },
        required: ["repo_full_name", "branch", "commit_sha"],
      },
    },
    {
      name: "expect_quiet_for",
      description:
        "Tell the platform you'll be silent for a while so the activity watchdog doesn't escalate you as 'stuck'. Use before running a long tool call that doesn't emit events (npm install, large test suite, docker build, heavy LLM sub-task). Pass `seconds` — the platform suppresses watchdog wakes for your parent about you for that duration. A subsequent call extends / overrides the window. A 0 or negative value clears the hint immediately. Doesn't silence emit_status or other events — only the silent-child watchdog check.",
      inputSchema: {
        type: "object" as const,
        properties: {
          seconds: {
            type: "number",
            description:
              "Expected silent duration in seconds. Pass 0 or negative to clear.",
          },
          reason: {
            type: "string",
            description:
              "Optional human-readable note (e.g., 'npm install'). Surfaced in logs.",
          },
        },
        required: ["seconds"],
      },
    },
    {
      name: "get_session_cost",
      description:
        "Return the running cost of THIS session — USD plus a per-model token breakdown (input, output, cache reads, cache writes). The orchestrator uses this during standup to self-report spend without scraping the UI. Updates within ~2s of an LLM/tool emission. Returns { sessionId, totals, byModel }. Workspace-scoped on the server side — the agent never names a workspace or session.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "get_session_tree_cost",
      description:
        "Return the aggregate cost of THIS session plus every session it has transitively spawned (orchestrator + all worker chains, recursively). Returns { rootSessionId, parent: { totals, byModel }, children: [{ sessionId, depth, summary, agentSlug, … }], totals }. Standup-grade — answers 'how much has this whole tree cost so far'.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "get_agent_cost",
      description:
        "Return THIS agent's total cost across every session it has ever run within a window. Returns { agentId, window, totals, byModel, byDay, topSessions }. Default window is '7d' (matches the standup cadence — 'last week cost X, what's the envelope this week?'). Pass `window`: '24h' | '7d' | '30d' | 'all' to slice differently.",
      inputSchema: {
        type: "object" as const,
        properties: {
          window: {
            type: "string",
            enum: ["24h", "7d", "30d", "all"],
            description: "Time window. Defaults to '7d'.",
          },
        },
      },
    },
    {
      name: "message_caller",
      description:
        "Push an explicit signal up to the session that spawned you. Use when you want to notify your parent orchestrator of a milestone, an ask, or a blocker — not for every progress update (use emit_status for cheap heartbeats). The platform routes this as a driverless wake into the parent's turn so the parent reasons about your signal without polling. Only works when this session has a parent (was spawned by another agent). Returns { ok, delivered }. delivered=false with reason='parent_not_orchestrator' means your parent is a worker and platform wakes aren't routed there; the call still succeeded as a no-op.",
      inputSchema: {
        type: "object" as const,
        properties: {
          summary: {
            type: "string",
            description:
              "Short, parent-readable signal (one line). This is what the parent reads first.",
          },
          body: {
            type: "string",
            description:
              "Optional longer detail — commit SHAs, file references, evidence for a decision.",
          },
          needs_response: {
            type: "boolean",
            description:
              "True if you're blocked and need the parent to inject_message back to you. False if you're just reporting status and will keep working.",
          },
        },
        required: ["summary"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args as Record<string, unknown>;

  switch (name) {
    case "emit_status":
      await postToSidecar("agent.status", a);
      return { content: [{ type: "text" as const, text: "Status reported." }] };

    case "emit_artifact":
      await postToSidecar("agent.artifact", a);
      return {
        content: [
          {
            type: "text" as const,
            text: `Artifact "${String(a?.title ?? "")}" shared with user.`,
          },
        ],
      };

    case "request_input":
      await postToSidecar("agent.input_request", a);
      return {
        content: [
          {
            type: "text" as const,
            text: `Question sent to user. Their response will arrive as a user message with request_id: ${String(a?.request_id ?? "")}`,
          },
        ],
      };

    case "emit_error":
      await postToSidecar("agent.error", a);
      return { content: [{ type: "text" as const, text: "Error reported." }] };

    case "share": {
      const path = String(a?.path ?? "");
      const title = a?.title;
      const shareId =
        typeof a?.share_id === "string" && a.share_id.trim() !== ""
          ? a.share_id
          : undefined;
      try {
        const res = await fetch(`${sidecarUrl}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, title, share_id: shareId }),
        });
        // Read as text first so we can surface a useful message even
        // when the sidecar returns an empty body — that happens when
        // the binary predates the /share route and axum's default
        // 404 handler responds with a bare status line.
        const bodyText = await res.text();
        let result: {
          ok?: boolean;
          share_id?: string;
          title?: string;
          share_type?: string;
          files?: unknown[];
          error?: string;
        } = {};
        if (bodyText) {
          try {
            result = JSON.parse(bodyText);
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Share failed: sidecar returned non-JSON (${res.status}): ${bodyText.slice(0, 200)}`,
                },
              ],
              isError: true,
            };
          }
        }
        if (!res.ok || !result.ok) {
          const hint =
            res.status === 404
              ? " — sidecar is missing the /share route (image likely predates the share subsystem; rebuild required)"
              : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `Share failed (${res.status}): ${result.error ?? bodyText.slice(0, 200) ?? "unknown error"}${hint}`,
              },
            ],
            isError: true,
          };
        }
        // Echo the share_id back to the agent so it can:
        //   1. update this share in place later (call `share` again with
        //      the same share_id — bytes change, pill stays, comment
        //      threads stay attached).
        //   2. open a new comment thread or list existing comments via
        //      `share_comment` / `list_share_comments` (X1A-91 + X1A-93).
        // Without the id in the result the agent had no programmatic
        // handle on its own artifacts and re-shared as a fresh row
        // every time — orphaning prior comment threads.
        const sid = result.share_id ?? "";
        const usageHint = sid
          ? [
              "",
              `share_id: ${sid}`,
              "",
              `To update this share (same pill, comments stay attached), call \`share\` again with share_id="${sid}".`,
              `To post a comment, call \`share_comment\` with share_id="${sid}".`,
              `To read existing comments, call \`list_share_comments\` with share_id="${sid}".`,
            ].join("\n")
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Shared "${result.title ?? path}" (${result.share_type ?? "file"}) with user. ${result.files?.length ?? 1} file(s).` +
                usageHint,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Share failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "read_share": {
      // Forwards to the sidecar's /read_share route, which in turn
      // calls the api with the session's credentials. The MCP layer
      // never touches user tokens or the api directly — the sidecar
      // is the trust boundary that knows this session's identity.
      //
      // Mirror of the share_comment plumbing: until the sidecar Rust
      // side lands the /read_share route, this tool returns a clean
      // sidecar_route_missing error so callers can detect the gap.
      const shareId =
        typeof a?.share_id === "string" ? a.share_id : "";
      const path = typeof a?.path === "string" ? a.path : undefined;
      if (!shareId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "read_share failed: share_id is required.",
            },
          ],
          isError: true,
        };
      }
      try {
        const qs = path ? `?path=${encodeURIComponent(path)}` : "";
        const res = await fetch(
          `${sidecarUrl}/read_share/${encodeURIComponent(shareId)}${qs}`,
        );
        if (res.status === 404) {
          // Two possible 404s: the sidecar doesn't have the route at
          // all (image predates this PR) or the share legitimately
          // doesn't exist. We can't distinguish without sniffing the
          // body, so check for an explicit `error: share_not_found`
          // payload — anything else is treated as a missing route.
          const bodyText = await res.text();
          let parsed: { error?: string } = {};
          if (bodyText) {
            try {
              parsed = JSON.parse(bodyText) as { error?: string };
            } catch {
              // not JSON — fall through to missing-route handling
            }
          }
          if (parsed.error === "share_not_found" || parsed.error === "file_not_found") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `read_share failed: share ${shareId} not found in this session's history.`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: "read_share failed: sidecar route /read_share is not yet implemented in this build (PRD 0006 Slice A follow-up).",
              },
            ],
            isError: true,
          };
        }
        const bodyText = await res.text();
        let parsed: {
          share_id?: string;
          path?: string;
          mime_type?: string;
          size?: number;
          content_b64?: string;
          error?: string;
        } = {};
        if (bodyText) {
          try {
            parsed = JSON.parse(bodyText);
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `read_share failed: non-JSON response (${res.status}): ${bodyText.slice(0, 200)}`,
                },
              ],
              isError: true,
            };
          }
        }
        if (res.status === 403) {
          return {
            content: [
              {
                type: "text" as const,
                text: `read_share failed: share ${shareId} belongs to a different session. Slice A only allows reading shares this session produced.`,
              },
            ],
            isError: true,
          };
        }
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `read_share failed (${res.status}): ${parsed.error ?? bodyText.slice(0, 200) ?? "unknown error"}`,
              },
            ],
            isError: true,
          };
        }
        // Return the JSON envelope verbatim. The agent decodes
        // `content_b64` locally — base64 is fine in the Claude
        // tool-result channel and is the lowest-friction way to
        // round-trip binary shares (PDF, PNG).
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(parsed, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `read_share failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "share_comment": {
      // Forwards to the sidecar's /share_comment route, which in turn
      // POSTs to /api/internal/share-comments with the X-Internal-Token
      // header. The sidecar — not the agent container — is the trust
      // boundary; this MCP tool only relays the JSON payload.
      //
      // Sidecar Rust route is tracked as a follow-up; see PR description.
      // Until that lands the tool returns a `sidecar_route_missing`
      // error so calls fail loudly instead of silently dropping.
      try {
        const res = await fetch(`${sidecarUrl}/share_comment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            thread_id: a?.thread_id,
            share_id: a?.share_id,
            scope: a?.scope,
            anchor: a?.anchor,
            body: a?.text,
          }),
        });
        const bodyText = await res.text();
        if (res.status === 404) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Share comment failed: sidecar route /share_comment is not yet implemented in this build (X1A-52 follow-up). Open a Linear issue if you need this end-to-end before the sidecar PR lands.",
              },
            ],
            isError: true,
          };
        }
        let result: {
          ok?: boolean;
          comment?: unknown;
          thread_id?: string;
          error?: string;
        } = {};
        if (bodyText) {
          try {
            result = JSON.parse(bodyText);
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Share comment failed: non-JSON response (${res.status}): ${bodyText.slice(0, 200)}`,
                },
              ],
              isError: true,
            };
          }
        }
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Share comment failed (${res.status}): ${result.error ?? bodyText.slice(0, 200) ?? "unknown error"}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Comment posted on thread ${result.thread_id ?? "(new)"}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Share comment failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "share_comment_resolve": {
      try {
        const res = await fetch(`${sidecarUrl}/share_comment_resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            thread_id: a?.thread_id,
            unresolve: Boolean(a?.unresolve),
          }),
        });
        if (res.status === 404) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Share comment resolve failed: sidecar route /share_comment_resolve is not yet implemented in this build (X1A-52 follow-up).",
              },
            ],
            isError: true,
          };
        }
        const text = await res.text();
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Share comment resolve failed (${res.status}): ${text.slice(0, 200)}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: a?.unresolve ? "Thread re-opened." : "Thread resolved.",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Share comment resolve failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "request_permission": {
      try {
        const res = await fetch(`${sidecarUrl}/permission/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scopes: a?.scopes ?? [],
            justification: a?.justification ?? "",
            requested_tool: a?.requested_tool,
            requested_args: a?.requested_args,
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `request_permission failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "list_collections": {
      try {
        const res = await fetch(`${sidecarUrl}/collections`);
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `list_collections failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "graph_query":
    case "graph_write":
    case "graph_relate":
    case "graph_resolve":
    case "graph_discover":
    case "vector_upsert":
    case "vector_search":
    case "vector_delete": {
      // Every graph_*/vector_* tool maps to the same-named sidecar
      // route with the same body shape, so a single switch arm
      // covers them all. Sidecar validates collection attachment
      // and forwards to NATS.
      const [domain, action] = name.split("_");
      try {
        const res = await fetch(`${sidecarUrl}/${domain}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(a ?? {}),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${name} failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "post_message": {
      try {
        const res = await fetch(`${sidecarUrl}/messaging/post_message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel: String(a?.channel ?? ""),
            text: String(a?.text ?? ""),
            thread_id: a?.thread_id,
            username: a?.username,
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `post_message failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "request_grant":
      await postToSidecar("agent.permission_request", a);
      return {
        content: [
          {
            type: "text" as const,
            text: `Grant request sent. User will Approve or Deny; the outcome arrives as a user message with request_id: ${String(a?.request_id ?? "")}`,
          },
        ],
      };

    case "list_spawnable_agents": {
      try {
        const res = await fetch(`${sidecarUrl}/spawnable`);
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `list_spawnable_agents failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "read_child_output": {
      const childId = String(a?.child_session_id ?? "");
      const qs = new URLSearchParams();
      if (a?.after_seq !== undefined)
        qs.set("after_seq", String(a["after_seq"]));
      if (a?.limit !== undefined) qs.set("limit", String(a["limit"]));
      try {
        const res = await fetch(
          `${sidecarUrl}/child/${encodeURIComponent(childId)}/events${
            qs.toString() ? `?${qs.toString()}` : ""
          }`,
        );
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `read_child_output failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "inject_message": {
      const childId = String(a?.child_session_id ?? "");
      try {
        const res = await fetch(
          `${sidecarUrl}/child/${encodeURIComponent(childId)}/inject`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: String(a?.text ?? "") }),
          },
        );
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `inject_message failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "spawn_session": {
      try {
        const modelArg =
          typeof a?.model === "string" && a.model.trim() !== ""
            ? String(a.model).trim()
            : undefined;
        const res = await fetch(`${sidecarUrl}/spawn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            child_agent_id: String(a?.child_agent_id ?? ""),
            ...(modelArg !== undefined ? { model: modelArg } : {}),
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `spawn_session failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "cancel_session": {
      try {
        const res = await fetch(`${sidecarUrl}/cancel_session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            child_session_id: String(a?.child_session_id ?? ""),
            reason: typeof a?.reason === "string" ? a.reason : null,
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `cancel_session failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "share_to_child": {
      try {
        const res = await fetch(`${sidecarUrl}/share_to_child`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            child_session_id: String(a?.child_session_id ?? ""),
            source_path: String(a?.source_path ?? ""),
            dest_path:
              typeof a?.dest_path === "string" && a.dest_path.trim() !== ""
                ? a.dest_path
                : null,
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `share_to_child failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "preview_deploy": {
      try {
        const res = await fetch(`${sidecarUrl}/preview/deploy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo_full_name: String(a?.repo_full_name ?? ""),
            branch: String(a?.branch ?? ""),
            commit_sha: String(a?.commit_sha ?? ""),
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `preview_deploy failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "expect_quiet_for": {
      try {
        const res = await fetch(`${sidecarUrl}/quiet-hint`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seconds: Number(a?.seconds ?? 0),
            reason: typeof a?.reason === "string" ? a.reason : null,
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `expect_quiet_for failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "get_session_cost":
    case "get_session_tree_cost":
    case "get_agent_cost": {
      // The sidecar already knows our session_id (env var at boot)
      // and resolves workspace on the api side, so the MCP surface
      // is "no arguments needed" for session + tree, and just the
      // window for agent. Keeps the tool surface honest — agents can't
      // probe other sessions' or workspaces' cost.
      const path =
        name === "get_session_cost"
          ? "/cost/session"
          : name === "get_session_tree_cost"
            ? "/cost/session-tree"
            : "/cost/agent";
      const qs =
        name === "get_agent_cost" && typeof a?.window === "string"
          ? `?window=${encodeURIComponent(String(a.window))}`
          : "";
      try {
        const res = await fetch(`${sidecarUrl}${path}${qs}`);
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${name} failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "message_caller": {
      try {
        const res = await fetch(`${sidecarUrl}/message-caller`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: String(a?.summary ?? ""),
            body: a?.body != null ? String(a.body) : null,
            needs_response: a?.needs_response === true,
          }),
        });
        const result = await res.json();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: !res.ok,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `message_caller failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "end_session": {
      // POST to the agent's /shutdown so the parent process terminates
      // cleanly — one session.completed event, no 15-minute idle-timer
      // drift afterwards. Do not exit this subprocess; the agent's
      // shutdown() will kill the container, this MCP included.
      const summary = String(a?.summary ?? "Session ended by agent");
      const agentUrl = process.env.AGENT_INJECT_URL || "http://localhost:8788";
      try {
        await fetch(`${agentUrl}/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary, is_success: true }),
        });
      } catch (err) {
        console.error(
          `[x1-mcp] /shutdown POST failed: ${(err as Error).message}`,
        );
      }
      return { content: [{ type: "text" as const, text: "Session ending." }] };
    }

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

await server.connect(new StdioServerTransport());
console.error("[x1-mcp] stdio server started");
