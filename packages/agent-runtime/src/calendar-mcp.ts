/**
 * Calendar MCP — Google Calendar list/create/update/delete events.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sidecarUrl = process.env.SIDECAR_URL || "http://localhost:9090";

async function postToSidecar(path: string, payload: unknown) {
  try {
    const res = await fetch(`${sidecarUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = {
        ok: false,
        error: { code: "non_json_reply", message: "non-JSON body" },
      };
    }
    return { ok: res.ok, body };
  } catch (err) {
    return {
      ok: false,
      body: {
        ok: false,
        error: { code: "sidecar_unreachable", message: (err as Error).message },
      },
    };
  }
}

const server = new Server(
  { name: "calendar", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_calendar_events",
      description:
        "List events on a Google Calendar between two times. Defaults to the user's primary calendar and a 7-day window starting now. Optional `q` filters by free-text across summary/description/attendees.",
      inputSchema: {
        type: "object" as const,
        properties: {
          calendar_id: {
            type: "string",
            description:
              'Defaults to "primary". Use a calendar\'s id (often an email-like string) for non-primary.',
          },
          time_min: {
            type: "string",
            description: "ISO-8601 start time. Defaults to now.",
          },
          time_max: {
            type: "string",
            description: "ISO-8601 end time. Defaults to time_min + 7 days.",
          },
          q: { type: "string", description: "Free-text search query." },
          max_results: { type: "number", description: "Defaults to 20." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "create_calendar_event",
      description:
        'Create a new Google Calendar event. Sends invites to attendees automatically. Times must be ISO-8601 with timezone offset (e.g. "2026-05-08T15:00:00-04:00"). Returns the new event id + web_view_link.',
      inputSchema: {
        type: "object" as const,
        properties: {
          calendar_id: {
            type: "string",
            description: 'Defaults to "primary".',
          },
          summary: { type: "string", description: "Event title." },
          description: { type: "string" },
          start: { type: "string", description: "ISO-8601 with TZ." },
          end: { type: "string", description: "ISO-8601 with TZ." },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Email addresses. Calendar will send invites.",
          },
          location: { type: "string" },
        },
        required: ["summary", "start", "end"],
        additionalProperties: false,
      },
    },
    {
      name: "update_calendar_event",
      description:
        "Modify an existing Google Calendar event. Only fields you pass are changed; omit to keep current value. Sends updates to attendees.",
      inputSchema: {
        type: "object" as const,
        properties: {
          calendar_id: {
            type: "string",
            description: 'Defaults to "primary".',
          },
          event_id: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          attendees: { type: "array", items: { type: "string" } },
          location: { type: "string" },
        },
        required: ["event_id"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_calendar_event",
      description:
        "Delete a Google Calendar event. Sends cancellation notices to attendees. There's no soft-delete in Calendar — once deleted it's gone (recoverable from the user's Google Calendar trash for 30 days).",
      inputSchema: {
        type: "object" as const,
        properties: {
          calendar_id: {
            type: "string",
            description: 'Defaults to "primary".',
          },
          event_id: { type: "string" },
        },
        required: ["event_id"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  let path: string;
  let body: Record<string, unknown>;
  switch (name) {
    case "list_calendar_events":
      path = "/calendar/list_events";
      body = {
        calendar_id: a.calendar_id,
        time_min: a.time_min,
        time_max: a.time_max,
        q: a.q,
        max_results: a.max_results,
      };
      break;
    case "create_calendar_event":
      path = "/calendar/create_event";
      body = {
        calendar_id: a.calendar_id,
        summary: a.summary,
        description: a.description,
        start: a.start,
        end: a.end,
        attendees: a.attendees,
        location: a.location,
      };
      break;
    case "update_calendar_event":
      path = "/calendar/update_event";
      body = {
        calendar_id: a.calendar_id,
        event_id: a.event_id,
        summary: a.summary,
        description: a.description,
        start: a.start,
        end: a.end,
        attendees: a.attendees,
        location: a.location,
      };
      break;
    case "delete_calendar_event":
      path = "/calendar/delete_event";
      body = { calendar_id: a.calendar_id, event_id: a.event_id };
      break;
    default:
      return {
        content: [{ type: "text", text: `unknown tool: ${name}` }],
        isError: true,
      };
  }
  const result = await postToSidecar(path, body);
  const isError =
    !result.ok ||
    (typeof result.body === "object" &&
      result.body !== null &&
      "ok" in result.body &&
      (result.body as { ok: boolean }).ok === false);
  return {
    content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
    isError,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
