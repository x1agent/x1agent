/**
 * Google Sheets handlers — `x1.provider.sheets.*` NATS subjects.
 *
 * Sheets API v4 is range-oriented: every read/write is scoped to an
 * A1-notation range like "Sheet1!A1:C10" or "InvoiceTracker!A:A". The
 * tools the agent gets reflect that primitive directly rather than
 * hiding it behind a uniform document abstraction.
 *
 * Per-call user OAuth via the api credential proxy. Provider holds
 * the access token only for the duration of one Sheets API call.
 */

import { CredentialError, mintGoogleToken } from "./credential.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";

export interface ReadSheetRangeRequest {
  user_id: string;
  spreadsheet_id: string;
  /** A1 notation: "Sheet1!A1:C10". Single cell, range, or whole column ok. */
  range: string;
}

export interface UpdateSheetRangeRequest {
  user_id: string;
  spreadsheet_id: string;
  range: string;
  /** 2D array of cell values. Strings, numbers, and booleans are passed through. */
  values: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
}

export interface AppendSheetRowRequest {
  user_id: string;
  spreadsheet_id: string;
  /** Sheet tab name (no range). Sheets infers the next blank row at the bottom. */
  sheet_name: string;
  values: ReadonlyArray<string | number | boolean | null>;
}

export interface CreateSpreadsheetRequest {
  user_id: string;
  title: string;
  /** Optional initial sheet tabs. Defaults to a single "Sheet1". */
  sheet_titles?: ReadonlyArray<string>;
  /**
   * Optional Drive folder id to create the spreadsheet inside. Sheets
   * API v4 doesn't accept parents; we create-then-move via Drive.
   */
  parent_folder_id?: string;
}

export interface SheetRangeReply {
  ok: true;
  range: string;
  values: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
}

export interface SheetUpdateReply {
  ok: true;
  range: string;
  updated_rows: number;
  updated_cols: number;
  updated_cells: number;
}

export interface SheetAppendReply {
  ok: true;
  /** A1 of the range that was written to (Sheets returns this). */
  updated_range: string;
}

export interface SpreadsheetEntry {
  spreadsheet_id: string;
  title: string;
  web_view_link: string;
  sheets: ReadonlyArray<{ id: number; title: string }>;
}

export interface CreateSpreadsheetReply {
  ok: true;
  spreadsheet: SpreadsheetEntry;
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
      code: "sheets_api_error",
      message: `sheets returned ${status}: ${body.slice(0, 500)}`,
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

export async function handleReadRange(
  req: ReadSheetRangeRequest,
): Promise<Reply<SheetRangeReply>> {
  if (!req.user_id || !req.spreadsheet_id || !req.range) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, spreadsheet_id, range required",
      },
    };
  }
  const minted = await mintToken(req.user_id, SHEETS_SCOPE);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const url = new URL(
    `${SHEETS_BASE}/${encodeURIComponent(req.spreadsheet_id)}/values/${encodeURIComponent(req.range)}`,
  );
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const body = (await resp.json()) as {
    range?: string;
    values?: Array<Array<string | number | boolean | null>>;
  };
  return {
    ok: true,
    range: body.range ?? req.range,
    values: body.values ?? [],
  };
}

export async function handleUpdateRange(
  req: UpdateSheetRangeRequest,
): Promise<Reply<SheetUpdateReply>> {
  if (
    !req.user_id ||
    !req.spreadsheet_id ||
    !req.range ||
    !Array.isArray(req.values)
  ) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, spreadsheet_id, range, values required",
      },
    };
  }
  const minted = await mintToken(req.user_id, SHEETS_SCOPE);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const url = new URL(
    `${SHEETS_BASE}/${encodeURIComponent(req.spreadsheet_id)}/values/${encodeURIComponent(req.range)}`,
  );
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: req.values }),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const body = (await resp.json()) as {
    updatedRange?: string;
    updatedRows?: number;
    updatedColumns?: number;
    updatedCells?: number;
  };
  return {
    ok: true,
    range: body.updatedRange ?? req.range,
    updated_rows: body.updatedRows ?? 0,
    updated_cols: body.updatedColumns ?? 0,
    updated_cells: body.updatedCells ?? 0,
  };
}

export async function handleAppendRow(
  req: AppendSheetRowRequest,
): Promise<Reply<SheetAppendReply>> {
  if (
    !req.user_id ||
    !req.spreadsheet_id ||
    !req.sheet_name ||
    !Array.isArray(req.values)
  ) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, spreadsheet_id, sheet_name, values required",
      },
    };
  }
  const minted = await mintToken(req.user_id, SHEETS_SCOPE);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  // append:append targets the named tab; Sheets finds the next blank
  // row at the bottom on its own. The range "Sheet1!A:Z" lets it scan
  // the whole tab.
  const range = `${req.sheet_name}!A:Z`;
  const url = new URL(
    `${SHEETS_BASE}/${encodeURIComponent(req.spreadsheet_id)}/values/${encodeURIComponent(range)}:append`,
  );
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [req.values] }),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const body = (await resp.json()) as {
    updates?: { updatedRange?: string };
  };
  return {
    ok: true,
    updated_range: body.updates?.updatedRange ?? range,
  };
}

export async function handleCreateSpreadsheet(
  req: CreateSpreadsheetRequest,
): Promise<Reply<CreateSpreadsheetReply>> {
  if (!req.user_id || !req.title) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id, title required" },
    };
  }

  // Sheets API uses spreadsheets scope for create; if the agent later
  // wants to move it into a folder, that's a Drive call needing the
  // Drive scope. Mint sheets first.
  const sheetsToken = await mintToken(req.user_id, SHEETS_SCOPE);
  if ("ok" in sheetsToken && sheetsToken.ok === false) return sheetsToken;
  const token = (sheetsToken as { token: string }).token;

  const sheetTitles = req.sheet_titles?.length ? req.sheet_titles : ["Sheet1"];
  const body = {
    properties: { title: req.title },
    sheets: sheetTitles.map((t) => ({ properties: { title: t } })),
  };
  const resp = await fetch(SHEETS_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const created = (await resp.json()) as {
    spreadsheetId?: string;
    properties?: { title?: string };
    spreadsheetUrl?: string;
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  if (!created.spreadsheetId) {
    return {
      ok: false,
      error: { code: "sheets_api_error", message: "no spreadsheet_id in reply" },
    };
  }

  // Move into a Drive folder if requested. Best-effort: a failure here
  // doesn't undo the create — the spreadsheet exists at root and the
  // user can move it manually. Surface the error to the agent.
  if (req.parent_folder_id) {
    const driveToken = await mintToken(req.user_id, DRIVE_SCOPE);
    if (!("ok" in driveToken && driveToken.ok === false)) {
      const dt = (driveToken as { token: string }).token;
      const moveUrl = new URL(
        `${DRIVE_FILES}/${encodeURIComponent(created.spreadsheetId)}`,
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
    spreadsheet: {
      spreadsheet_id: created.spreadsheetId,
      title: created.properties?.title ?? req.title,
      web_view_link:
        created.spreadsheetUrl ??
        `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
      sheets: (created.sheets ?? []).flatMap((s) =>
        s.properties?.sheetId !== undefined && s.properties?.title
          ? [{ id: s.properties.sheetId, title: s.properties.title }]
          : [],
      ),
    },
  };
}
