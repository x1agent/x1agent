import type {
  AppendSessionEventInput,
  SessionEventRepository,
} from "../ports/session-event-repository.js";
import type { SessionEvent } from "../domain/event.js";
import { SessionEventDuplicateError } from "../domain/event.js";

export interface AppendSessionEventDeps {
  events: SessionEventRepository;
}

/**
 * Internal use case — called by the api's NATS subscriber as events
 * flow past. Returns the row on success; returns `null` when the row
 * was already persisted (duplicate delivery), so the caller can ack
 * NATS without raising.
 */
export async function appendSessionEvent(
  deps: AppendSessionEventDeps,
  input: AppendSessionEventInput,
): Promise<SessionEvent | null> {
  try {
    return await deps.events.append(input);
  } catch (err) {
    if (err instanceof SessionEventDuplicateError) {
      return null;
    }
    throw err;
  }
}
