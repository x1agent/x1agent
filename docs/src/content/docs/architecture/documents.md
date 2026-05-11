---
title: Documents (per-product NATS surfaces)
description: Today's read/write subjects for Google Docs, Sheets, and friends. The unified "documents" domain is a proposal — see proposals/documents-domain.
sidebar:
  order: 12
---

> **Status — per-product today.** Each structured-document product has its own NATS subject namespace under `x1.provider.<product>.<op>`. The unified abstraction described in [proposals/documents-domain](/proposals/documents-domain) is not yet implemented.

The provider deployments and their subjects:

| Subject prefix | Provider | Operations |
|---|---|---|
| `x1.provider.docs.*` | google-workspace | `read`, `create`, `replace_text`, `append_paragraph` |
| `x1.provider.sheets.*` | google-workspace | `read_range`, `update_range`, `append_row`, `create` |
| `x1.provider.calendar.*` | google-workspace | `list_events`, `create_event`, `update_event`, `delete_event` |
| `x1.provider.email.*` | google-workspace | `list_threads`, `get_message`, `send`, `trash` |
| `x1.provider.files.*` | google-workspace | `list`, `get`, `download`, `upload`, `update_content`, `update_metadata`, `create_folder`, `trash` |

See `packages/providers/google-workspace/src/index.ts` for the binding handler list. Microsoft 365 has no provider deployment yet.
