import { DomainError } from "@x1agent/kernel";

export type AccessGrantKind = "domain" | "email";
export type AccessGrantRole = "admin" | "member";

/**
 * Workspace-scoped access grant. Two flavours share a row shape:
 *
 *   kind='domain', value='foocorp.com'        any @foocorp.com user can auto-join
 *   kind='email',  value='someone@foocorp.com'  that specific email can auto-join
 *
 * The first sign-in by a matching user materialises a workspace
 * membership at the row's `defaultRole`. Subsequent sign-ins are a
 * no-op (the membership already exists).
 *
 * Grants are workspace-admin tools, parallel to per-email invitations
 * but idempotent + bulk-friendly. The deployment-wide ALLOWED_DOMAINS
 * gate is still enforced for non-grantees and non-invitees; both
 * grants AND invitations override it via the AccessGate port.
 */
export interface WorkspaceAccessGrant {
  id: string;
  workspaceId: string;
  kind: AccessGrantKind;
  /**
   * Lower-cased, trimmed. For 'domain' it's the bare domain
   * ('foocorp.com'); for 'email' it's the full address.
   */
  value: string;
  defaultRole: AccessGrantRole | null;
  expiresAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InvalidAccessGrantValueError extends DomainError {
  readonly code = "invalid_access_grant_value";
  constructor(
    public readonly kind: AccessGrantKind,
    public readonly value: string,
  ) {
    super(
      kind === "domain"
        ? `grant value ${JSON.stringify(value)} is not a valid DNS domain`
        : `grant value ${JSON.stringify(value)} is not a valid email`,
    );
    this.name = "InvalidAccessGrantValueError";
  }
}

export function normalizeGrantValue(
  kind: AccessGrantKind,
  raw: string,
): string {
  const lower = raw.trim().toLowerCase();
  if (kind === "domain") {
    if (!DOMAIN_RE.test(lower)) {
      throw new InvalidAccessGrantValueError(kind, raw);
    }
    return lower;
  }
  if (!EMAIL_RE.test(lower)) {
    throw new InvalidAccessGrantValueError(kind, raw);
  }
  return lower;
}

/**
 * Pull the domain portion out of an email. Used by the AccessGate
 * domain-kind match path.
 */
export function emailDomain(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).toLowerCase();
}
