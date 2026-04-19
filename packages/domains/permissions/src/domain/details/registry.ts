import { InvalidGrantShapeError } from "../grant.js";
import type { GrantType } from "../grant.js";

/**
 * Each `grant_type` owns a validator for its `details` shape. The registry
 * is the single place that decides whether an incoming grant shape is
 * understood. Unknown types reject at the boundary — there is no "anything
 * goes" path.
 */
export type DetailsValidator<T extends Record<string, unknown>> = (
  raw: unknown,
) => T;

const registry = new Map<string, DetailsValidator<Record<string, unknown>>>();

export function registerGrantType<T extends Record<string, unknown>>(
  type: string,
  validator: DetailsValidator<T>,
): void {
  registry.set(type, validator as DetailsValidator<Record<string, unknown>>);
}

export function validateGrantDetails(
  grantType: GrantType,
  raw: unknown,
): Record<string, unknown> {
  const v = registry.get(grantType);
  if (!v) throw new InvalidGrantShapeError(`unknown grant_type: ${grantType}`);
  return v(raw);
}

export function listRegisteredGrantTypes(): readonly string[] {
  return Array.from(registry.keys()).sort();
}

/**
 * Test hook. Production code should never clear the registry — the
 * built-in types are registered at module load and are expected to
 * stay registered.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
