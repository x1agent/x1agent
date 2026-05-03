import { ValidationError } from "@x1agent/kernel";
import type { Attachment, AttachmentEnvValue } from "../domain/attachment.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";
import type { AttachmentRepository } from "../ports/attachment-repository.js";

const SECRET_REF_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export interface AttachInput {
  agentId: string;
  workspaceId: string;
  catalogEntryId: string;
  envJson: Record<string, unknown>;
  toolScopesGranted?: string[];
  createdBy: string | null;
}

/**
 * Validates user-supplied env values against the catalog entry's
 * manifest. The catalog entry must belong to the same workspace as
 * the agent — the API layer enforces that the agent's workspaceId
 * matches the slug being acted on; we pass it through here so the
 * check is one indirection away from the SQL.
 */
export class AttachmentService {
  constructor(
    private readonly attachments: AttachmentRepository,
    private readonly catalog: CatalogRepository,
  ) {}

  list(agentId: string): Promise<Attachment[]> {
    return this.attachments.listByAgent(agentId);
  }

  async attach(input: AttachInput): Promise<Attachment> {
    const entry = await this.catalog.getById(
      input.workspaceId,
      input.catalogEntryId,
    );
    if (!entry) {
      throw new ValidationError(
        "catalog_entry_id",
        "catalog entry not found in this workspace",
      );
    }

    const validatedEnv: Record<string, AttachmentEnvValue> = {};
    // Required entries from the manifest must be present.
    for (const [envName, decl] of Object.entries(entry.manifest.env)) {
      const supplied = input.envJson[envName];
      if (supplied === undefined || supplied === null) {
        if (decl.required !== false) {
          throw new ValidationError(
            `env.${envName}`,
            "is required by the manifest",
          );
        }
        continue;
      }
      if (typeof supplied !== "object" || Array.isArray(supplied)) {
        throw new ValidationError(`env.${envName}`, "must be an object");
      }
      const s = supplied as Record<string, unknown>;
      if (decl.kind === "secret") {
        if (s.kind !== "secret" || typeof s.ref !== "string") {
          throw new ValidationError(
            `env.${envName}`,
            "must be { kind: 'secret', ref: '<WORKSPACE_SECRET_NAME>' }",
          );
        }
        if (!SECRET_REF_RE.test(s.ref)) {
          throw new ValidationError(
            `env.${envName}.ref`,
            "must match ^[A-Z_][A-Z0-9_]{0,63}$",
          );
        }
        validatedEnv[envName] = { kind: "secret", ref: s.ref };
      } else {
        if (s.kind !== "value" || typeof s.value !== "string") {
          throw new ValidationError(
            `env.${envName}`,
            "must be { kind: 'value', value: '<literal>' }",
          );
        }
        validatedEnv[envName] = { kind: "value", value: s.value };
      }
    }
    // Reject env keys not declared by the manifest — typo guard.
    for (const k of Object.keys(input.envJson)) {
      if (!(k in entry.manifest.env)) {
        throw new ValidationError(
          `env.${k}`,
          "not declared in the manifest",
        );
      }
    }

    const allScopes = Object.values(entry.manifest.tool_scopes).flat();
    const toolScopesGranted = input.toolScopesGranted ?? allScopes;
    return this.attachments.upsert({
      agentId: input.agentId,
      catalogEntryId: input.catalogEntryId,
      envJson: validatedEnv,
      toolScopesGranted,
      createdBy: input.createdBy,
    });
  }

  detach(agentId: string, attachmentId: string): Promise<boolean> {
    return this.attachments.delete(agentId, attachmentId);
  }
}
