import { ValidationError } from "@x1agent/kernel";
import {
  RUNTIME_TYPES,
  type RuntimeType as SharedRuntimeType,
} from "@x1agent/shared";

export { RUNTIME_TYPES } from "@x1agent/shared";
export type RuntimeType = SharedRuntimeType;

export function RuntimeType(raw: string): RuntimeType {
  if ((RUNTIME_TYPES as readonly string[]).includes(raw)) {
    return raw as RuntimeType;
  }
  throw new ValidationError(
    "runtime_type",
    `must be one of ${RUNTIME_TYPES.join(", ")}`,
  );
}
