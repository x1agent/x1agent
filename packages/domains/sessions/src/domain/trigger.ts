import { ValidationError } from "@x1agent/kernel";

export const TRIGGER_SOURCES = ["user", "scheduler"] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export function TriggerSource(raw: string): TriggerSource {
  if ((TRIGGER_SOURCES as readonly string[]).includes(raw)) {
    return raw as TriggerSource;
  }
  throw new ValidationError(
    "triggered_by",
    `must be one of ${TRIGGER_SOURCES.join(", ")}`,
  );
}
