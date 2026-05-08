/**
 * Google Docs handlers — `x1.provider.docs.*` NATS subjects.
 *
 * Google Docs API is fundamentally a stream-of-mutations API. Reads
 * return the document tree (paragraphs, runs, lists, tables);
 * writes are batchUpdate calls with typed mutation requests. The
 * agent gets a small set of pragmatic tools rather than the raw
 * 50-mutation-types API:
 *
 *   read_doc                — full plaintext (we flatten the tree)
 *   create_doc              — empty Doc with a title
 *   replace_text_in_doc     — find/replace across the body
 *   append_paragraph_to_doc — write a new paragraph at the end
 */

import { CredentialError, mintGoogleToken } from "./credential.js";

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DOCS_BASE = "https://docs.googleapis.com/v1/documents";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";

export interface ReadDocRequest {
  user_id: string;
  document_id: string;
}

export interface CreateDocRequest {
  user_id: string;
  title: string;
  parent_folder_id?: string;
}

export interface ReplaceTextRequest {
  user_id: string;
  document_id: string;
  find: string;
  replace: string;
  /** Defaults to true (case-sensitive). */
  match_case?: boolean;
}

export interface AppendParagraphRequest {
  user_id: string;
  document_id: string;
  text: string;
}

export interface DocReadReply {
  ok: true;
  document_id: string;
  title: string;
  /** Flattened plaintext of the document body. */
  body_text: string;
  /** End index of the body, useful for follow-up insert ops. */
  end_index: number;
  web_view_link: string;
}

export interface DocEntry {
  document_id: string;
  title: string;
  web_view_link: string;
}

export interface DocCreateReply {
  ok: true;
  document: DocEntry;
}

export interface DocPatchReply {
  ok: true;
  document_id: string;
  applied_replies: number;
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

function credentialErrorReply(err: CredentialError, scope: string): ErrorReply {
  return {
    ok: false,
    error: {
      code: err.kind,
      message: err.message,
      required_scope: err.kind === "permission_required" ? scope : undefined,
    },
  };
}

function apiErrorReply(status: number, body: string): ErrorReply {
  return {
    ok: false,
    error: {
      code: "docs_api_error",
      message: `docs returned ${status}: ${body.slice(0, 500)}`,
    },
  };
}

async function mintToken(
  userId: string,
  scope: string,
): Promise<{ token: string } | ErrorReply> {
  try {
    const minted = await mintGoogleToken(userId, scope);
    return { token: minted.accessToken };
  } catch (err) {
    if (err instanceof CredentialError) return credentialErrorReply(err, scope);
    throw err;
  }
}

// Walk a Docs document tree and concatenate textRun content. Skips
// sections like images / lists' bullet markers (those are handled by
// the Docs API automatically on render). Sufficient for the agent to
// understand and reason about a document's text content.
type DocBody = {
  content?: Array<{
    endIndex?: number;
    paragraph?: {
      elements?: Array<{
        textRun?: { content?: string };
      }>;
    };
    table?: {
      tableRows?: Array<{
        tableCells?: Array<{
          content?: DocBody["content"];
        }>;
      }>;
    };
  }>;
};

function flattenDocBody(body: DocBody | undefined): {
  text: string;
  endIndex: number;
} {
  if (!body || !body.content) return { text: "", endIndex: 1 };
  let text = "";
  let endIndex = 1;
  for (const block of body.content) {
    if (block.endIndex && block.endIndex > endIndex) endIndex = block.endIndex;
    if (block.paragraph?.elements) {
      for (const el of block.paragraph.elements) {
        if (el.textRun?.content) text += el.textRun.content;
      }
    } else if (block.table?.tableRows) {
      for (const row of block.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          const sub = flattenDocBody({ content: cell.content ?? [] });
          text += sub.text;
        }
      }
    }
  }
  return { text, endIndex };
}

export async function handleReadDoc(
  req: ReadDocRequest,
): Promise<Reply<DocReadReply>> {
  if (!req.user_id || !req.document_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id, document_id required" },
    };
  }
  const minted = await mintToken(req.user_id, DOCS_SCOPE);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const url = `${DOCS_BASE}/${encodeURIComponent(req.document_id)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const doc = (await resp.json()) as {
    documentId?: string;
    title?: string;
    body?: DocBody;
  };
  const { text, endIndex } = flattenDocBody(doc.body);
  return {
    ok: true,
    document_id: doc.documentId ?? req.document_id,
    title: doc.title ?? "(untitled)",
    body_text: text,
    end_index: endIndex,
    web_view_link: `https://docs.google.com/document/d/${doc.documentId ?? req.document_id}/edit`,
  };
}

export async function handleCreateDoc(
  req: CreateDocRequest,
): Promise<Reply<DocCreateReply>> {
  if (!req.user_id || !req.title) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id, title required" },
    };
  }
  const docsToken = await mintToken(req.user_id, DOCS_SCOPE);
  if ("ok" in docsToken && docsToken.ok === false) return docsToken;
  const token = (docsToken as { token: string }).token;

  const resp = await fetch(DOCS_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: req.title }),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const created = (await resp.json()) as {
    documentId?: string;
    title?: string;
  };
  if (!created.documentId) {
    return {
      ok: false,
      error: { code: "docs_api_error", message: "no documentId in reply" },
    };
  }

  if (req.parent_folder_id) {
    const driveToken = await mintToken(req.user_id, DRIVE_SCOPE);
    if (!("ok" in driveToken && driveToken.ok === false)) {
      const dt = (driveToken as { token: string }).token;
      const moveUrl = new URL(
        `${DRIVE_FILES}/${encodeURIComponent(created.documentId)}`,
      );
      moveUrl.searchParams.set("addParents", req.parent_folder_id);
      moveUrl.searchParams.set("removeParents", "root");
      moveUrl.searchParams.set("fields", "id");
      await fetch(moveUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${dt}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    }
  }

  return {
    ok: true,
    document: {
      document_id: created.documentId,
      title: created.title ?? req.title,
      web_view_link: `https://docs.google.com/document/d/${created.documentId}/edit`,
    },
  };
}

export async function handleReplaceText(
  req: ReplaceTextRequest,
): Promise<Reply<DocPatchReply>> {
  if (!req.user_id || !req.document_id || req.find === undefined) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, document_id, find required",
      },
    };
  }
  const minted = await mintToken(req.user_id, DOCS_SCOPE);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const requests = [
    {
      replaceAllText: {
        containsText: { text: req.find, matchCase: req.match_case ?? true },
        replaceText: req.replace,
      },
    },
  ];
  const url = `${DOCS_BASE}/${encodeURIComponent(req.document_id)}:batchUpdate`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const body = (await resp.json()) as {
    documentId?: string;
    replies?: unknown[];
  };
  return {
    ok: true,
    document_id: body.documentId ?? req.document_id,
    applied_replies: body.replies?.length ?? 0,
  };
}

export async function handleAppendParagraph(
  req: AppendParagraphRequest,
): Promise<Reply<DocPatchReply>> {
  if (!req.user_id || !req.document_id || typeof req.text !== "string") {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, document_id, text required",
      },
    };
  }
  const minted = await mintToken(req.user_id, DOCS_SCOPE);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  // For append we need the current end index of the body. One small
  // GET call up front; cheap.
  const metaUrl = `${DOCS_BASE}/${encodeURIComponent(req.document_id)}`;
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaResp.ok) return apiErrorReply(metaResp.status, await metaResp.text());
  const meta = (await metaResp.json()) as { body?: DocBody };
  const { endIndex } = flattenDocBody(meta.body);
  // Insert at endIndex - 1: Docs reserves the last index for the
  // structural "newline of the segment" element. Inserting AT that
  // exact index returns invalid; insert one before it.
  const insertAt = Math.max(1, endIndex - 1);

  const requests = [
    {
      insertText: {
        location: { index: insertAt },
        text: `\n${req.text}`,
      },
    },
  ];
  const url = `${DOCS_BASE}/${encodeURIComponent(req.document_id)}:batchUpdate`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const body = (await resp.json()) as {
    documentId?: string;
    replies?: unknown[];
  };
  return {
    ok: true,
    document_id: body.documentId ?? req.document_id,
    applied_replies: body.replies?.length ?? 0,
  };
}
