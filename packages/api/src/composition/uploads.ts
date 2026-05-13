import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { systemClock, type Clock } from "@x1agent/kernel";
import {
  DEFAULT_UPLOADS_CONFIG,
  InMemoryRateLimiter,
  LocalDiskStorage,
  PostgresUploadRepository,
  S3Storage,
  type S3ClientLike,
  type UploadStorage,
  type UploadsConfig,
  createUploadRoutes,
} from "@x1agent/domain-uploads";

export interface UploadsCompositionEnv {
  sql: postgres.Sql<Record<string, unknown>>;
  /** Base URL the api is reachable on (used to build local upload URLs). */
  apiUrl: string;
  /** HMAC secret for local-disk signed-URL ingress. Falls back to JWT secret. */
  hmacSecret: string;
}

export interface UploadsComposition {
  config: UploadsConfig;
  storage: UploadStorage;
  repository: PostgresUploadRepository;
  rateLimiter: InMemoryRateLimiter;
  routesFactory: (deps: {
    requireAuth: Parameters<typeof createUploadRoutes>[0]["requireAuth"];
    getActor: Parameters<typeof createUploadRoutes>[0]["getActor"];
  }) => ReturnType<typeof createUploadRoutes>;
  clock: Clock;
}

/**
 * Compose the uploads subsystem. Storage backend is chosen by
 * `UPLOAD_STORAGE_BACKEND` ∈ {local, s3}; everything else has a
 * documented default in DEFAULT_UPLOADS_CONFIG / .env.example.
 *
 * For S3 the `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
 * packages are loaded LAZILY (first method call) so an install that
 * sticks with the local backend doesn't pay the SDK boot cost and
 * doesn't need the packages installed at all. The chart adds the deps
 * to packages/api when it switches the backend; the domain package
 * itself stays SDK-free.
 */
export function composeUploads(
  env: UploadsCompositionEnv,
): UploadsComposition {
  const config = readUploadsConfigFromEnv();
  const clock = systemClock;
  const repository = new PostgresUploadRepository(env.sql);
  const rateLimiter = new InMemoryRateLimiter(clock);

  const backend = (process.env.UPLOAD_STORAGE_BACKEND || "local").toLowerCase();
  let storage: UploadStorage;
  if (backend === "s3") {
    const bucket = process.env.UPLOAD_S3_BUCKET;
    if (!bucket) {
      throw new Error(
        "UPLOAD_STORAGE_BACKEND=s3 but UPLOAD_S3_BUCKET is unset",
      );
    }
    const region = process.env.UPLOAD_S3_REGION || "us-east-1";
    storage = new S3Storage({ bucket, client: makeLazyS3Client(region) });
  } else {
    const rootDir = process.env.UPLOAD_STORAGE_PATH || "./data/uploads";
    storage = new LocalDiskStorage({
      rootDir,
      publicBaseUrl: `${env.apiUrl.replace(/\/$/, "")}/api/uploads`,
      hmacSecret: env.hmacSecret,
      clock,
    });
  }

  return {
    config,
    storage,
    repository,
    rateLimiter,
    clock,
    routesFactory: ({ requireAuth, getActor }) =>
      createUploadRoutes({
        uploads: repository,
        storage,
        rateLimiter,
        clock,
        config,
        uuid: () => randomUUID(),
        requireAuth,
        getActor,
      }),
  };
}

function readUploadsConfigFromEnv(): UploadsConfig {
  const max = Number(process.env.UPLOAD_MAX_BYTES);
  const allow = (process.env.UPLOAD_ALLOWED_MIMES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const pendingH = Number(process.env.UPLOAD_PENDING_TTL_HOURS);
  const attachedD = Number(process.env.UPLOAD_ATTACHED_TTL_DAYS);
  const initRate = Number(process.env.UPLOAD_RATE_INIT_PER_MIN);
  return {
    maxBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_UPLOADS_CONFIG.maxBytes,
    allowedMimes: allow.length > 0 ? allow : DEFAULT_UPLOADS_CONFIG.allowedMimes,
    pendingTtlMs:
      Number.isFinite(pendingH) && pendingH > 0
        ? pendingH * 60 * 60 * 1000
        : DEFAULT_UPLOADS_CONFIG.pendingTtlMs,
    attachedTtlMs:
      Number.isFinite(attachedD) && attachedD > 0
        ? attachedD * 24 * 60 * 60 * 1000
        : DEFAULT_UPLOADS_CONFIG.attachedTtlMs,
    perMessageMax: DEFAULT_UPLOADS_CONFIG.perMessageMax,
    initPerMinute:
      Number.isFinite(initRate) && initRate > 0
        ? initRate
        : DEFAULT_UPLOADS_CONFIG.initPerMinute,
    signedUrlTtlMs: DEFAULT_UPLOADS_CONFIG.signedUrlTtlMs,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ResolvedSdk {
  client: any;
  Put: any;
  Get: any;
  Head: any;
  Del: any;
  presign: any;
}

/**
 * Returns an S3ClientLike whose first method call lazily imports
 * `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. Failure to
 * resolve the SDK surfaces as a clear operator-facing error so a
 * misconfigured deploy doesn't silently swallow uploads.
 */
function makeLazyS3Client(region: string): S3ClientLike {
  let sdkPromise: Promise<ResolvedSdk> | null = null;
  const sdk = (): Promise<ResolvedSdk> => {
    if (sdkPromise) return sdkPromise;
    sdkPromise = (async () => {
      try {
        const cli = await import("@aws-sdk/client-s3");
        const ps = await import("@aws-sdk/s3-request-presigner");
        return {
          client: new (cli as any).S3Client({ region }),
          Put: (cli as any).PutObjectCommand,
          Get: (cli as any).GetObjectCommand,
          Head: (cli as any).HeadObjectCommand,
          Del: (cli as any).DeleteObjectCommand,
          presign: (ps as any).getSignedUrl,
        };
      } catch (err) {
        throw new Error(
          "UPLOAD_STORAGE_BACKEND=s3 requires @aws-sdk/client-s3 and " +
            "@aws-sdk/s3-request-presigner. Install them in packages/api " +
            "or switch to UPLOAD_STORAGE_BACKEND=local. Underlying error: " +
            (err as Error).message,
        );
      }
    })();
    return sdkPromise;
  };

  return {
    async putObject({ bucket, key, body, contentType }) {
      const { client, Put } = await sdk();
      await client.send(
        new Put({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async getObject({ bucket, key, range }) {
      const { client, Get } = await sdk();
      const cmd = new Get({
        Bucket: bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      });
      const r = await client.send(cmd);
      if (!r.Body) return null;
      const chunks: Uint8Array[] = [];
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    },
    async headObject({ bucket, key }) {
      const { client, Head } = await sdk();
      try {
        const r = await client.send(new Head({ Bucket: bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0) };
      } catch (err) {
        if (
          (err as any)?.name === "NotFound" ||
          (err as any)?.$metadata?.httpStatusCode === 404
        ) {
          return null;
        }
        throw err;
      }
    },
    async deleteObject({ bucket, key }) {
      const { client, Del } = await sdk();
      await client.send(new Del({ Bucket: bucket, Key: key }));
    },
    async presignPut({ bucket, key, contentType, contentLength, expiresInSeconds }) {
      const { client, Put, presign } = await sdk();
      const cmd = new Put({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      });
      const url: string = await presign(client, cmd, {
        expiresIn: expiresInSeconds,
      });
      return url;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
