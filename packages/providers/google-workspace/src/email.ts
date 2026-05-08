/**
 * Gmail handlers — `x1.provider.email.*` NATS subjects.
 *
 * Gmail API v1 with the `gmail.modify` restricted scope (covers
 * read, label, send, trash). Restricted = needs Google review +
 * CASA audit before External-user-type installs can roll it out
 * to non-org users; Internal user-type installs ship immediately.
 *
 * Tools the agent gets:
 *
 *   list_threads     paginated list with optional Gmail q= search
 *   get_message      full message body, headers, attachment metadata
 *   send_email       compose + send (RFC 822, base64url encoded)
 *   trash_email      move a message to Trash (reversible by user)
 */

import { CredentialError, mintGoogleToken } from "./credential.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface ListThreadsRequest {
  user_id: string;
  /** Gmail search query: "from:foo subject:bar is:unread", etc. */
  q?: string;
  /** Max threads. Defaults to 20. */
  max_results?: number;
  page_token?: string;
}

export interface GetMessageRequest {
  user_id: string;
  message_id: string;
}

export interface SendEmailRequest {
  user_id: string;
  to: string;
  subject: string;
  body: string;
  /** Optional CC list. */
  cc?: ReadonlyArray<string>;
  /** Optional BCC list. */
  bcc?: ReadonlyArray<string>;
  /** Defaults to text/plain. Set "text/html" for HTML body. */
  content_type?: "text/plain" | "text/html";
  /**
   * If set, send as a reply to this thread. Sets the
   * In-Reply-To/References headers and threadId.
   */
  reply_to_thread_id?: string;
}

export interface TrashEmailRequest {
  user_id: string;
  message_id: string;
}

export interface ThreadEntry {
  thread_id: string;
  snippet?: string;
  history_id?: string;
  message_count?: number;
}

export interface ListThreadsReply {
  ok: true;
  threads: ReadonlyArray<ThreadEntry>;
  next_page_token?: string;
}

export interface MessageReply {
  ok: true;
  message: {
    message_id: string;
    thread_id: string;
    /** From / To / Subject / Date — flattened key/value. */
    headers: Record<string, string>;
    /** Best-effort plaintext body (Gmail's `text/plain` part if present, else html-stripped). */
    body_text: string;
    snippet?: string;
    label_ids?: ReadonlyArray<string>;
  };
}

export interface SendReply {
  ok: true;
  message_id: string;
  thread_id: string;
}

export interface OkReply {
  ok: true;
}

export interface ErrorReply {
  ok: false;
  error: {
    code: string;
    message: string;
    required_scope?: string;
  };
}

export type Reply<T> = T | ErrorReply;

function credentialErrorReply(err: CredentialError): ErrorReply {
  return {
    ok: false,
    error: {
      code: err.kind,
      message: err.message,
      required_scope: err.kind === "permission_required" ? GMAIL_SCOPE : undefined,
    },
  };
}

function apiErrorReply(status: number, body: string): ErrorReply {
  return {
    ok: false,
    error: {
      code: "gmail_api_error",
      message: `gmail returned ${status}: ${body.slice(0, 500)}`,
    },
  };
}

async function mintToken(
  userId: string,
): Promise<{ token: string } | ErrorReply> {
  try {
    const minted = await mintGoogleToken(userId, GMAIL_SCOPE);
    return { token: minted.accessToken };
  } catch (err) {
    if (err instanceof CredentialError) return credentialErrorReply(err);
    throw err;
  }
}

export async function handleListThreads(
  req: ListThreadsRequest,
): Promise<Reply<ListThreadsReply>> {
  if (!req.user_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id required" },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const url = new URL(`${GMAIL_BASE}/threads`);
  if (req.q) url.searchParams.set("q", req.q);
  url.searchParams.set("maxResults", String(req.max_results ?? 20));
  if (req.page_token) url.searchParams.set("pageToken", req.page_token);

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const body = (await resp.json()) as {
    threads?: Array<{
      id?: string;
      snippet?: string;
      historyId?: string;
    }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  };
  const threads = (body.threads ?? [])
    .filter((t): t is { id: string; snippet?: string; historyId?: string } =>
      Boolean(t.id),
    )
    .map((t) => ({
      thread_id: t.id,
      snippet: t.snippet,
      history_id: t.historyId,
    }));
  const reply: ListThreadsReply = { ok: true, threads };
  if (body.nextPageToken) reply.next_page_token = body.nextPageToken;
  return reply;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );
}

function flattenBodyText(part: GmailPart | undefined): string {
  if (!part) return "";
  // Prefer text/plain. Fall back to text/html (stripped of tags).
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const found = flattenBodyText(sub);
      if (found) return found;
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    const html = decodeBase64Url(part.body.data);
    return html.replace(/<[^>]+>/g, "");
  }
  return "";
}

export async function handleGetMessage(
  req: GetMessageRequest,
): Promise<Reply<MessageReply>> {
  if (!req.user_id || !req.message_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id, message_id required" },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const url = new URL(
    `${GMAIL_BASE}/messages/${encodeURIComponent(req.message_id)}`,
  );
  url.searchParams.set("format", "full");
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const m = (await resp.json()) as {
    id?: string;
    threadId?: string;
    snippet?: string;
    labelIds?: string[];
    payload?: GmailPart & {
      headers?: Array<{ name?: string; value?: string }>;
    };
  };
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    if (h.name && h.value) headers[h.name] = h.value;
  }
  return {
    ok: true,
    message: {
      message_id: m.id ?? req.message_id,
      thread_id: m.threadId ?? "",
      headers,
      body_text: flattenBodyText(m.payload),
      snippet: m.snippet,
      label_ids: m.labelIds,
    },
  };
}

function rfc822(req: SendEmailRequest): string {
  const lines: string[] = [];
  lines.push(`To: ${req.to}`);
  if (req.cc?.length) lines.push(`Cc: ${req.cc.join(", ")}`);
  if (req.bcc?.length) lines.push(`Bcc: ${req.bcc.join(", ")}`);
  lines.push(`Subject: ${req.subject}`);
  lines.push("MIME-Version: 1.0");
  lines.push(
    `Content-Type: ${req.content_type ?? "text/plain"}; charset="UTF-8"`,
  );
  lines.push("");
  lines.push(req.body);
  return lines.join("\r\n");
}

function base64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function handleSendEmail(
  req: SendEmailRequest,
): Promise<Reply<SendReply>> {
  if (!req.user_id || !req.to || !req.subject || typeof req.body !== "string") {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, to, subject, body required",
      },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const raw = base64url(rfc822(req));
  const body: Record<string, unknown> = { raw };
  if (req.reply_to_thread_id) body.threadId = req.reply_to_thread_id;

  const resp = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const sent = (await resp.json()) as { id?: string; threadId?: string };
  if (!sent.id) {
    return {
      ok: false,
      error: { code: "gmail_api_error", message: "no message id in reply" },
    };
  }
  return {
    ok: true,
    message_id: sent.id,
    thread_id: sent.threadId ?? "",
  };
}

export async function handleTrashEmail(
  req: TrashEmailRequest,
): Promise<Reply<OkReply>> {
  if (!req.user_id || !req.message_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id, message_id required" },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const url = `${GMAIL_BASE}/messages/${encodeURIComponent(req.message_id)}/trash`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  return { ok: true };
}
