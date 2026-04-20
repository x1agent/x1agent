import { randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import postgres from "postgres";
import type { SharedResource } from "@x1agent/agent-resources";
import type { BranchCredential } from "../../domain/postgres-branch.js";
import type {
  MintBranchInput,
  PostgresBranchMinter,
} from "../../ports/postgres-branch-minter.js";

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Opens a short-lived connection to the workspace Postgres using the
 * admin credential stored in the workspace namespace's K8s Secret, and
 * runs `CREATE DATABASE ... TEMPLATE ...` / `CREATE ROLE ...` / password
 * rotation. Closes the pool before returning.
 */
export class StatefulSetPostgresBranchMinter implements PostgresBranchMinter {
  constructor(private readonly kc: k8s.KubeConfig) {}

  async mint(input: MintBranchInput): Promise<BranchCredential> {
    const admin = await this.adminDsn(input.resource, input.namespace);
    const { host, port, mainDatabase } = readConnParts(input.resource);
    const branchId = input.branchId;
    const password = randomBytes(24).toString("base64url");

    const sql = postgres(admin.dsn, { max: 1, idle_timeout: 2 });
    try {
      // CREATE DATABASE can't run inside a transaction block; run these
      // statements one at a time and swallow the "already exists" race.
      await ensureRole(sql, branchId, password);
      await ensureDatabase(sql, branchId, mainDatabase);
      await alignOwnership(sql, branchId);
    } finally {
      await sql.end({ timeout: 5 });
    }

    const userEnc = encodeURIComponent(branchId);
    const passEnc = encodeURIComponent(password);
    return {
      dsn: `postgresql://${userEnc}:${passEnc}@${host}:${port}/${branchId}`,
      host,
      port,
      database: branchId,
      user: branchId,
      password,
    };
  }

  async revokeBranch(input: {
    resource: SharedResource;
    namespace: string;
    branchId: string;
  }): Promise<void> {
    const admin = await this.adminDsn(input.resource, input.namespace);
    const sql = postgres(admin.dsn, { max: 1, idle_timeout: 2 });
    try {
      // Kill any still-open connections on the branch DB so DROP can proceed.
      await sql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${input.branchId} AND pid <> pg_backend_pid()
      `.catch(() => undefined);
      await sql
        .unsafe(`DROP DATABASE IF EXISTS "${quoteIdent(input.branchId)}"`)
        .catch(() => undefined);
      await sql
        .unsafe(`DROP ROLE IF EXISTS "${quoteIdent(input.branchId)}"`)
        .catch(() => undefined);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  private async adminDsn(
    resource: SharedResource,
    namespace: string,
  ): Promise<{ dsn: string }> {
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const secret = await coreApi.readNamespacedSecret({
      name: resource.adminSecretRef,
      namespace,
    });
    const data = secret.data ?? {};
    const user = decodeBase64(data.POSTGRES_USER);
    const password = decodeBase64(data.POSTGRES_PASSWORD);
    const { host, port } = readConnParts(resource);
    const dsn = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/postgres`;
    return { dsn };
  }
}

function readConnParts(resource: SharedResource): {
  host: string;
  port: number;
  mainDatabase: string;
} {
  const cfg = resource.config as Record<string, unknown>;
  return {
    host: (cfg.serviceHost as string) ?? "localhost",
    port: (cfg.servicePort as number) ?? 5432,
    mainDatabase: (cfg.mainDatabase as string) ?? "postgres",
  };
}

function decodeBase64(v: string | undefined): string {
  if (!v) return "";
  return Buffer.from(v, "base64").toString("utf8");
}

function quoteIdent(id: string): string {
  // Defensive even though branchId is already sanitized: doubling any
  // embedded quote means a hostile branchId still cannot break out.
  return id.replace(/"/g, '""');
}

async function ensureRole(
  sql: Sql,
  roleName: string,
  password: string,
): Promise<void> {
  const exists = await sql`
    SELECT 1 FROM pg_roles WHERE rolname = ${roleName}
  `;
  const q = quoteIdent(roleName);
  const pwd = password.replace(/'/g, "''");
  if (exists.length === 0) {
    await sql.unsafe(
      `CREATE ROLE "${q}" LOGIN PASSWORD '${pwd}' NOCREATEDB NOCREATEROLE NOSUPERUSER`,
    );
  } else {
    await sql.unsafe(`ALTER ROLE "${q}" WITH PASSWORD '${pwd}' LOGIN`);
  }
}

async function ensureDatabase(
  sql: Sql,
  dbName: string,
  template: string,
): Promise<void> {
  const exists = await sql`
    SELECT 1 FROM pg_database WHERE datname = ${dbName}
  `;
  if (exists.length > 0) return;
  const dbQ = quoteIdent(dbName);
  const tplQ = quoteIdent(template);
  // Owner gets set to the matching role in alignOwnership so this
  // statement doesn't race with CREATE ROLE.
  await sql.unsafe(
    `CREATE DATABASE "${dbQ}" TEMPLATE "${tplQ}"`,
  );
}

async function alignOwnership(sql: Sql, name: string): Promise<void> {
  const q = quoteIdent(name);
  await sql.unsafe(`ALTER DATABASE "${q}" OWNER TO "${q}"`);
  await sql.unsafe(`REVOKE ALL ON DATABASE "${q}" FROM PUBLIC`);
  await sql.unsafe(`GRANT ALL ON DATABASE "${q}" TO "${q}"`);
}
