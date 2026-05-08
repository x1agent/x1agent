import { ValidationError } from "@x1agent/kernel";

declare const imageNameBrand: unique symbol;
export type ImageName = string & { readonly [imageNameBrand]: true };

/**
 * Workspace image name. Used as:
 *   * the unique key within a workspace's image catalog
 *   * the path component in the registry: ws/<workspace_id>/<name>:latest
 *   * the slug shown in the UI table and the agent dropdown
 *
 * Pattern: lowercase letter or digit / hyphen, must start with a
 * letter, no consecutive hyphens, 1..63 chars. Matches Kubernetes
 * DNS-1123 label rules so the same name can be reused as a label
 * value if needed.
 */
const IMAGE_NAME_RE = /^[a-z]([a-z0-9]|-(?!-)){0,61}[a-z0-9]$|^[a-z]$/;

export function ImageName(raw: string): ImageName {
  const trimmed = raw.trim();
  if (!IMAGE_NAME_RE.test(trimmed)) {
    throw new ValidationError(
      "name",
      "must be lowercase letters, digits, hyphens; 1–63 chars; start with a letter; no consecutive hyphens",
    );
  }
  return trimmed as ImageName;
}
