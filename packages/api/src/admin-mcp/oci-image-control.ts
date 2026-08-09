import type postgres from "postgres";

type Sql = postgres.Sql<Record<string, unknown>>;

const OCI_DIGEST_REF =
  /^([a-z0-9.-]+(?::[0-9]+)?)\/([a-z0-9._/-]+)@sha256:([a-f0-9]{64})$/;

const OCI_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  registry_auth_required: "registry authentication is required",
  manifest_unavailable: "registry manifest is unavailable",
  digest_mismatch: "registry returned a different content digest",
  image_incompatible: "OCI image is incompatible with this installation",
};

export function safeFailure(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown };
  const candidateCode =
    typeof candidate?.code === "string" ? candidate.code.toLowerCase() : "";
  const code = Object.hasOwn(OCI_FAILURE_MESSAGES, candidateCode)
    ? candidateCode
    : "image_validation_failed";
  return {
    code,
    message: OCI_FAILURE_MESSAGES[code] ?? "OCI image validation failed",
  };
}

export class AdminMcpOciImageControl {
  private readonly allowedRegistries: Set<string>;

  constructor(
    private readonly sql: Sql,
    allowedRegistries: readonly string[],
  ) {
    this.allowedRegistries = new Set(
      allowedRegistries.map((value) => value.trim().toLowerCase()).filter(Boolean),
    );
  }

  parse(reference: string) {
    const match = OCI_DIGEST_REF.exec(reference.trim().toLowerCase());
    if (!match) {
      throw Object.assign(
        new Error("OCI reference must be registry/repository@sha256:<64 hex>"),
        { code: "validation_error", details: { field: "oci_reference" } },
      );
    }
    const registry = match[1]!;
    if (!this.allowedRegistries.has(registry)) {
      throw Object.assign(new Error("OCI registry is not allowlisted"), {
        code: "image_incompatible",
        details: { registry },
      });
    }
    return {
      reference: reference.trim().toLowerCase(),
      registry,
      repository: match[2]!,
      digest: `sha256:${match[3]!}`,
    };
  }

  async register(input: {
    workspaceId: string;
    actorUserId: string;
    name: string;
    displayName: string;
    description?: string | null;
    ociReference: string;
  }): Promise<{ id: string }> {
    const parsed = this.parse(input.ociReference);
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO agent_images (
          workspace_id, name, display_name, description, built_ref,
          is_preset, dockerfile_source, build_status, build_log,
          source_kind, requested_ref, created_by
        ) VALUES (
          ${input.workspaceId}, ${input.name}, ${input.displayName.trim()},
          ${input.description ?? null}, '', false, '', 'pending', '',
          'external_oci', ${parsed.reference}, ${input.actorUserId}
        ) RETURNING id
      `;
      await tx`
        INSERT INTO agent_image_oci_operations (image_id, requested_ref)
        VALUES (${rows[0]!.id}, ${parsed.reference})
      `;
      return rows[0]!;
    });
  }

  async retry(
    workspaceId: string,
    imageId: string,
    requestedRef: string,
  ): Promise<boolean> {
    this.parse(requestedRef);
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`
        UPDATE agent_images SET build_status = 'pending', build_log = '',
          updated_at = now()
        WHERE id = ${imageId} AND workspace_id = ${workspaceId}
          AND source_kind = 'external_oci'
          AND build_status NOT IN ('pending', 'building')
        RETURNING id
      `;
      if (!rows[0]) return false;
      await tx`
        INSERT INTO agent_image_oci_operations (image_id, requested_ref)
        VALUES (${imageId}, ${requestedRef})
        ON CONFLICT (image_id)
          WHERE status IN ('pending', 'processing') DO NOTHING
      `;
      return true;
    });
  }

  async processNext(): Promise<boolean> {
    const operation = await this.sql.begin(async (tx) => {
      const rows = await tx<{
        id: string;
        image_id: string;
        requested_ref: string;
        workspace_id: string;
      }[]>`
        SELECT op.id, op.image_id, op.requested_ref, img.workspace_id
        FROM agent_image_oci_operations op
        JOIN agent_images img ON img.id = op.image_id
        WHERE op.status = 'pending'
          OR (op.status = 'processing' AND op.updated_at < now() - interval '5 minutes')
        ORDER BY op.created_at ASC
        FOR UPDATE OF op SKIP LOCKED LIMIT 1
      `;
      if (!rows[0]) return null;
      await tx`
        UPDATE agent_image_oci_operations
        SET status = 'processing', attempt = attempt + 1, updated_at = now()
        WHERE id = ${rows[0].id}
      `;
      await tx`
        UPDATE agent_images SET build_status = 'building', build_log = '',
          updated_at = now() WHERE id = ${rows[0].image_id}
      `;
      return rows[0];
    });
    if (!operation) return false;
    try {
      const parsed = this.parse(operation.requested_ref);
      const host = parsed.registry === "docker.io"
        ? "registry-1.docker.io"
        : parsed.registry;
      const response = await fetch(
        `https://${host}/v2/${parsed.repository}/manifests/${parsed.digest}`,
        {
          method: "HEAD",
          headers: {
            Accept: [
              "application/vnd.oci.image.manifest.v1+json",
              "application/vnd.docker.distribution.manifest.v2+json",
              "application/vnd.oci.image.index.v1+json",
            ].join(", "),
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        throw Object.assign(
          new Error(`registry manifest validation returned ${response.status}`),
          { code: response.status === 401 ? "registry_auth_required" : "manifest_unavailable" },
        );
      }
      const returnedDigest = response.headers.get("docker-content-digest");
      if (returnedDigest && returnedDigest.toLowerCase() !== parsed.digest) {
        throw Object.assign(new Error("registry returned a different digest"), {
          code: "digest_mismatch",
        });
      }
      await this.sql.begin(async (tx) => {
        await tx`
          UPDATE agent_images SET built_ref = ${parsed.reference},
            resolved_digest_ref = ${parsed.reference}, build_status = 'succeeded',
            last_built_at = now(), updated_at = now()
          WHERE id = ${operation.image_id} AND workspace_id = ${operation.workspace_id}
        `;
        await tx`
          UPDATE agent_image_oci_operations SET status = 'completed',
            completed_at = now(), updated_at = now() WHERE id = ${operation.id}
        `;
      });
    } catch (error) {
      const failure = safeFailure(error);
      await this.sql.begin(async (tx) => {
        await tx`
          UPDATE agent_images SET build_status = 'failed',
            build_log = ${failure.message}, updated_at = now()
          WHERE id = ${operation.image_id}
        `;
        await tx`
          UPDATE agent_image_oci_operations SET status = 'failed',
            last_error_code = ${failure.code},
            last_error_message = ${failure.message}, completed_at = now(),
            updated_at = now() WHERE id = ${operation.id}
        `;
      });
    }
    return true;
  }
}
