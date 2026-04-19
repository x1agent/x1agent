import { ValidationError } from "@x1agent/kernel";

export const SESSION_STATUSES = [
  "pending",
  "running",
  "complete",
  "failed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export function SessionStatus(raw: string): SessionStatus {
  if ((SESSION_STATUSES as readonly string[]).includes(raw)) {
    return raw as SessionStatus;
  }
  throw new ValidationError(
    "status",
    `must be one of ${SESSION_STATUSES.join(", ")}`,
  );
}

export function isTerminal(status: SessionStatus): boolean {
  return status === "complete" || status === "failed";
}
