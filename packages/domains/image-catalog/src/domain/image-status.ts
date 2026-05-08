/**
 * Build status states for an `agent_images` row.
 *
 * - `ready`     — platform preset; built out-of-band by repo CI.
 * - `pending`   — workspace row just created or its Dockerfile changed;
 *                 awaiting a builder pickup.
 * - `building`  — a Kaniko Job is currently running for this row.
 * - `succeeded` — last build pushed; `built_ref` is fresh; row is
 *                 selectable in the agent dropdown.
 * - `failed`    — last build failed; `build_log` carries the tail of
 *                 the Kaniko pod logs. The previous `built_ref` (if any)
 *                 is preserved so an agent already pinned to the prior
 *                 digest keeps working until the admin saves a fix.
 *
 * `ready` and `succeeded` are both "selectable" states; the API filters
 * the agent dropdown to `(ready, succeeded)`. The two are kept distinct
 * so observers can tell "preset" from "workspace-built" without having
 * to also check `is_preset`.
 */
export type ImageStatus =
  | "ready"
  | "pending"
  | "building"
  | "succeeded"
  | "failed";

export const SELECTABLE_STATUSES: ReadonlySet<ImageStatus> = new Set([
  "ready",
  "succeeded",
]);

export function isSelectable(status: ImageStatus): boolean {
  return SELECTABLE_STATUSES.has(status);
}

export function isTerminal(status: ImageStatus): boolean {
  return status === "ready" || status === "succeeded" || status === "failed";
}
