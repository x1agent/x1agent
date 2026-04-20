import { ValidationError } from "@x1agent/kernel";

export const RUNTIME_TYPES = ["claude_code"] as const;
export type RuntimeType = (typeof RUNTIME_TYPES)[number];

export function RuntimeType(raw: string): RuntimeType {
  if ((RUNTIME_TYPES as readonly string[]).includes(raw)) {
    return raw as RuntimeType;
  }
  throw new ValidationError(
    "runtime_type",
    `must be one of ${RUNTIME_TYPES.join(", ")}`,
  );
}
