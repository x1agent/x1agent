/**
 * Google Calendar handlers — `x1.provider.calendar.*` NATS subjects.
 *
 * Calendar API v3. Tools the agent gets:
 *
 *   list_events    list/search events on a calendar between two times
 *   create_event   add a new event with summary/start/end/description
 *   update_event   modify an existing event (PATCH)
 *   delete_event   remove (no soft-delete equivalent in Calendar API)
 */

import { CredentialError, mintGoogleToken } from "./credential.js";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export interface ListEventsRequest {
  user_id: string;
  /** Defaults to "primary" (the user's main calendar). */
  calendar_id?: string;
  /** ISO-8601. Defaults to now. */
  time_min?: string;
  /** ISO-8601. Defaults to time_min + 7 days. */
  time_max?: string;
  /** Free-text search across summary/description/attendees. */
  q?: string;
  /** Max events. Defaults to 20, capped by Calendar at 2500. */
  max_results?: number;
}

export interface CreateEventRequest {
  user_id: string;
  calendar_id?: string;
  summary: string;
  description?: string;
  /** ISO-8601 with timezone. */
  start: string;
  /** ISO-8601 with timezone. */
  end: string;
  /** Email addresses. Calendar will send invites. */
  attendees?: ReadonlyArray<string>;
  location?: string;
}

export interface UpdateEventRequest {
  user_id: string;
  calendar_id?: string;
  event_id: string;
  summary?: string;
  description?: string;
  start?: string;
  end?: string;
  attendees?: ReadonlyArray<string>;
  location?: string;
}

export interface DeleteEventRequest {
  user_id: string;
  calendar_id?: string;
  event_id: string;
}

export interface CalendarEvent {
  event_id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  attendees?: ReadonlyArray<{ email: string; response_status?: string }>;
  location?: string;
  web_view_link?: string;
}

export interface ListEventsReply {
  ok: true;
  events: ReadonlyArray<CalendarEvent>;
  next_page_token?: string;
}

export interface EventMutationReply {
  ok: true;
  event: CalendarEvent;
}

export interface DeleteEventReply {
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
      code: "calendar_api_error",
      message: `calendar returned ${status}: ${body.slice(0, 500)}`,
    },
  };
}

async function mintToken(
  userId: string,
): Promise<{ token: string } | ErrorReply> {
  try {
    const minted = await mintGoogleToken(userId, CALENDAR_SCOPE);
    return { token: minted.accessToken };
  } catch (err) {
    if (err instanceof CredentialError)
      return credentialErrorReply(err, CALENDAR_SCOPE);
    throw err;
  }
}

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  location?: string;
  htmlLink?: string;
}

function eventFromGoogle(e: GoogleEvent): CalendarEvent | null {
  if (!e.id) return null;
  const start = e.start?.dateTime ?? e.start?.date ?? "";
  const end = e.end?.dateTime ?? e.end?.date ?? "";
  return {
    event_id: e.id,
    summary: e.summary ?? "(no title)",
    description: e.description,
    start,
    end,
    attendees: e.attendees
      ?.filter((a): a is { email: string; responseStatus?: string } =>
        Boolean(a.email),
      )
      .map((a) => ({ email: a.email, response_status: a.responseStatus })),
    location: e.location,
    web_view_link: e.htmlLink,
  };
}

export async function handleListEvents(
  req: ListEventsRequest,
): Promise<Reply<ListEventsReply>> {
  if (!req.user_id) {
    return {
      ok: false,
      error: { code: "missing_param", message: "user_id required" },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const calendarId = req.calendar_id ?? "primary";
  const url = new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(req.max_results ?? 20));
  url.searchParams.set("timeMin", req.time_min ?? new Date().toISOString());
  if (req.time_max) url.searchParams.set("timeMax", req.time_max);
  if (req.q) url.searchParams.set("q", req.q);

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const body = (await resp.json()) as {
    items?: GoogleEvent[];
    nextPageToken?: string;
  };
  const events = (body.items ?? [])
    .map(eventFromGoogle)
    .filter((e): e is CalendarEvent => e !== null);
  const reply: ListEventsReply = { ok: true, events };
  if (body.nextPageToken) reply.next_page_token = body.nextPageToken;
  return reply;
}

export async function handleCreateEvent(
  req: CreateEventRequest,
): Promise<Reply<EventMutationReply>> {
  if (!req.user_id || !req.summary || !req.start || !req.end) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id, summary, start, end required",
      },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const calendarId = req.calendar_id ?? "primary";
  const body: Record<string, unknown> = {
    summary: req.summary,
    start: { dateTime: req.start },
    end: { dateTime: req.end },
  };
  if (req.description) body.description = req.description;
  if (req.location) body.location = req.location;
  if (req.attendees?.length) {
    body.attendees = req.attendees.map((email) => ({ email }));
  }

  const url = new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  // sendUpdates=all → invitees get an email; we pass it explicitly
  // because Calendar's default ("none") makes invites silent which
  // an agent shouldn't do without telling the operator.
  url.searchParams.set("sendUpdates", "all");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const created = eventFromGoogle((await resp.json()) as GoogleEvent);
  if (!created) {
    return {
      ok: false,
      error: { code: "calendar_api_error", message: "no event id in reply" },
    };
  }
  return { ok: true, event: created };
}

export async function handleUpdateEvent(
  req: UpdateEventRequest,
): Promise<Reply<EventMutationReply>> {
  if (!req.user_id || !req.event_id) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id and event_id required",
      },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const calendarId = req.calendar_id ?? "primary";
  const body: Record<string, unknown> = {};
  if (req.summary !== undefined) body.summary = req.summary;
  if (req.description !== undefined) body.description = req.description;
  if (req.location !== undefined) body.location = req.location;
  if (req.start !== undefined) body.start = { dateTime: req.start };
  if (req.end !== undefined) body.end = { dateTime: req.end };
  if (req.attendees !== undefined) {
    body.attendees = req.attendees.map((email) => ({ email }));
  }

  const url = new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(req.event_id)}`,
  );
  url.searchParams.set("sendUpdates", "all");
  const resp = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return apiErrorReply(resp.status, await resp.text());
  const updated = eventFromGoogle((await resp.json()) as GoogleEvent);
  if (!updated) {
    return {
      ok: false,
      error: { code: "calendar_api_error", message: "no event id in reply" },
    };
  }
  return { ok: true, event: updated };
}

export async function handleDeleteEvent(
  req: DeleteEventRequest,
): Promise<Reply<DeleteEventReply>> {
  if (!req.user_id || !req.event_id) {
    return {
      ok: false,
      error: {
        code: "missing_param",
        message: "user_id and event_id required",
      },
    };
  }
  const minted = await mintToken(req.user_id);
  if ("ok" in minted && minted.ok === false) return minted;
  const token = (minted as { token: string }).token;

  const calendarId = req.calendar_id ?? "primary";
  const url = new URL(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(req.event_id)}`,
  );
  url.searchParams.set("sendUpdates", "all");
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok && resp.status !== 410)
    // 410 Gone == already deleted, treat as success
    return apiErrorReply(resp.status, await resp.text());
  return { ok: true };
}
