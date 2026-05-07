---
title: Documents domain
description: NATS contract for structured document read/write across Google Docs / Sheets, Microsoft Word / Excel, and future structured-document providers.
sidebar:
  order: 12
---

The `documents` domain handles **structured document mutations** — the read/write surface for products like Google Docs, Google Sheets, Microsoft Word Online, and Microsoft Excel Online. It is distinct from the `files` domain, which handles binary file storage (Drive folders, OneDrive folders, GCS objects).

The boundary matters: a Drive file `report.pdf` is a binary blob — `files.download` returns the bytes. A Drive document `Q1 Plan` is a structured tree of paragraphs, tables, lists, and styled runs — uploading the bytes back makes no sense. `documents` is the right surface for "replace the placeholder text in this template" or "set cell B5 to this value" — operations that the underlying API expresses as field-level patches, not file-level uploads.

## Operations

Three core operations. Each is a NATS request/reply on `x1.provider.documents.<op>`. Provider deployments subscribe; the sidecar publishes when the agent calls a `documents` MCP tool.

### `read_document`

```
subject:  x1.provider.documents.read
request:  { user_id, document_id, range?: { ... } }
reply:    { content: { ... }, format: "doc" | "sheet" }
```

`document_id` is provider-opaque (Google: a Drive file id; Microsoft: a Graph itemId). `range` is optional and provider-shaped — for sheets it's `{ sheet_name, a1_range }`; for docs it's `{ start_index, end_index }`. The provider returns content in a normalized shape (definition WIP — see "Open question: content shape" below).

### `patch_document`

```
subject:  x1.provider.documents.patch
request:  { user_id, document_id, mutations: [ ... ] }
reply:    { applied: number, document_id }
```

`mutations` is an ordered array of provider-supported edit operations. Each mutation is a tagged union — `{ kind: "replace_text", find, replace }`, `{ kind: "set_cell", sheet, a1, value }`, `{ kind: "append_paragraph", text, style? }`. Providers reject unknown mutation kinds with a clear error; the agent sees `unsupported_mutation` and adapts.

### `list_documents`

```
subject:  x1.provider.documents.list
request:  { user_id, query: { type?: "doc" | "sheet", containing_folder_id?, name_contains? } }
reply:    { documents: [{ id, name, type, last_modified, web_url }, ...] }
```

Used when the agent doesn't yet have a document id — discovery first, then read/patch.

## Credentials

Providers in this domain never see user OAuth tokens directly. The sidecar's user-OAuth credential proxy (Phase 0 substrate) mints a fresh access token per request and attaches it as `Authorization: Bearer <token>` on the outbound provider→Google/Microsoft call. The provider invokes the credential proxy via `mint_user_token(user_id, "google", scope)` (or `"microsoft-365"`); the access token is held in memory for the duration of the single API call and never persisted or logged.

## Scopes

Per-API scopes — the credential proxy enforces that the user has granted the right one before returning a token.

| Provider | Scope |
|---|---|
| Google Docs (read) | `https://www.googleapis.com/auth/documents.readonly` |
| Google Docs (read+write) | `https://www.googleapis.com/auth/documents` |
| Google Sheets (read) | `https://www.googleapis.com/auth/spreadsheets.readonly` |
| Google Sheets (read+write) | `https://www.googleapis.com/auth/spreadsheets` |
| Microsoft Word + Excel | `Files.ReadWrite` (Microsoft Graph delegated permission) |

None of these are sensitive or restricted in Google's verification taxonomy — they ship without app review.

## Workspace tenant isolation

Every operation carries `user_id`; the provider validates that the document id is reachable by the user before issuing an API call. CLAUDE.md first-principle #7 applies: a document attached to one workspace's agent must never appear in another workspace's picker, and a document id passed in from a foreign workspace's session is rejected at the provider boundary.

## Open question — content shape

The biggest open design question is the normalized shape of a document. Three positions:

1. **Provider-native shape, pass-through.** The provider returns Google's `Document` JSON or Microsoft's `Workbook` JSON unmodified. Agents cope. Pro: zero loss. Con: the agent has to learn each provider's API and the LLM's context fills with provider-specific JSON.
2. **Markdown projection.** The provider lossily converts to Markdown (with a `web_url` back-reference for fidelity). Agents read Markdown, the world's most LLM-friendly format. Con: round-trip via `patch_document` is hard — Markdown→Docs API mutation requires non-trivial diffing.
3. **A small typed AST.** A normalized `{ paragraphs: [...], tables: [...] }` shape that both providers can produce and consume. Pro: cross-provider symmetry. Con: design effort, and edge cases (revision history, suggestions, comments) add complexity fast.

V1 should ship Option 1 (provider-native pass-through) for read paths and a small set of well-defined mutation kinds for `patch_document`. Option 2/3 lands later if/when the agent UX makes the case.

## Implementations expected at v1

- **Google Workspace provider** — implements all three operations against Docs API v1 and Sheets API v4.
- **Microsoft 365 provider** (future) — same operations against Microsoft Graph `/me/drive/items/{id}/workbook` and `/me/drive/items/{id}` (for Word).

## Out of scope for v1

- Real-time collaborative editing (operational transform, comments stream). The agent's mental model is "load → mutate → save"; concurrent edits from human users get last-write-wins semantics with the provider's own conflict resolution.
- Document creation from scratch. v1 reads/patches existing documents; creation lands later. Workaround: agent uses `files` to upload a template, then `documents` to patch.
- Format conversion (export Docs → PDF, etc.). Use `files.export` for that.
