import * as k8s from "@kubernetes/client-node";
import { PassThrough, Readable, type Writable, type Readable as ReadableT } from "node:stream";

/**
 * Snapshot a child session pod's /workspace into the parent
 * orchestrator pod's /workspace/workers/<childSessionId>/.
 *
 * Two `kubectl exec` round-trips: `tar cf -` in the child, `tar xf -`
 * in the parent. The tar bytes are buffered into memory between the
 * two streams — bounded by `maxBytes` so a runaway child can't OOM
 * the api pod. v1 caps at 50 MiB; raise if the operator hits it.
 *
 * Returns a summary the route serializes back to the orchestrator.
 * Throws on any failure (pod gone, exec rejected, tar exited non-zero,
 * size cap exceeded) — the route maps that to a 4xx / 5xx.
 *
 * Authorization is the caller's responsibility — this helper trusts
 * the caller already verified `child.parent_session_id == parent.id`.
 */

export interface PullFromChildOptions {
  kubeConfig: k8s.KubeConfig;
  namespace: string;
  parentSessionId: string;
  childSessionId: string;
  /**
   * Subpaths under /workspace to include. Empty / undefined snapshots
   * the entire workspace (excluding `.x1/` to skip the runtime overlay
   * symlinks and ephemeral upload mirror).
   */
  paths?: readonly string[];
  /** Hard cap on tar bytes; default 50 MiB. */
  maxBytes?: number;
}

export interface PullFromChildResult {
  files: number;
  totalBytes: number;
  destPath: string;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 90_000;

export async function pullFromChild(
  opts: PullFromChildOptions,
): Promise<PullFromChildResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const coreApi = opts.kubeConfig.makeApiClient(k8s.CoreV1Api);

  const childPod = await findSessionPod(coreApi, opts.namespace, opts.childSessionId);
  if (!childPod) {
    const err = new Error(`child workspace unavailable (no pod for session ${opts.childSessionId} — worker may have completed)`);
    (err as Error & { code: string }).code = "child_workspace_unavailable";
    throw err;
  }
  const parentPod = await findSessionPod(coreApi, opts.namespace, opts.parentSessionId);
  if (!parentPod) {
    const err = new Error(`parent pod for session ${opts.parentSessionId} not found`);
    (err as Error & { code: string }).code = "parent_pod_missing";
    throw err;
  }

  const destPath = `/workspace/workers/${opts.childSessionId}`;
  const exec = new k8s.Exec(opts.kubeConfig);

  // 1. Pre-stage the dest dir in the parent pod. A bare `tar xf -`
  //    would also create dirs as it extracts, but mkdir up front is
  //    explicit and ensures the directory survives even if the tar is
  //    empty (e.g. worker hasn't written any files yet).
  await runExec(exec, opts.namespace, parentPod, "agent", [
    "sh",
    "-c",
    `mkdir -p ${shQuote(destPath)} && rm -rf ${shQuote(destPath)}/* ${shQuote(destPath)}/.[!.]* 2>/dev/null; true`,
  ], null, null);

  // 2. tar cf - in the child. `--warning=no-file-changed` keeps tar
  //    from exiting non-zero if a file changes mid-read; agents
  //    sometimes write concurrently. `--exclude` drops the runtime
  //    overlay symlinks + the upload mirror we don't want to copy.
  const tarArgs = buildTarArgs(opts.paths);
  const tarBuffer = await captureExecStdout(
    exec,
    opts.namespace,
    childPod,
    "agent",
    tarArgs,
    maxBytes,
  );

  if (tarBuffer.length === 0) {
    return { files: 0, totalBytes: 0, destPath };
  }

  // 3. tar xf - in the parent, pipe the buffered tar to its stdin.
  await pipeTarIntoPod(
    exec,
    opts.namespace,
    parentPod,
    "agent",
    destPath,
    tarBuffer,
  );

  // 4. Count files for the response (best-effort; doesn't fail the
  //    pull if `find` errors).
  const fileCount = await countFiles(exec, opts.namespace, parentPod, destPath);

  return { files: fileCount, totalBytes: tarBuffer.length, destPath };
}

async function findSessionPod(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  sessionId: string,
): Promise<string | null> {
  const list = await coreApi.listNamespacedPod({
    namespace,
    labelSelector: `session-id=${sessionId}`,
  });
  // Prefer a running pod; fall back to any (the agent container may be
  // Init / Pending / ContainerCreating right after spawn — caller
  // decides whether that's acceptable).
  const running = list.items.find(
    (p) => p.status?.phase === "Running" && (p.metadata?.deletionTimestamp ?? null) === null,
  );
  const fallback = list.items[0];
  return running?.metadata?.name ?? fallback?.metadata?.name ?? null;
}

function buildTarArgs(paths: readonly string[] | undefined): string[] {
  const base = [
    "tar",
    "cf",
    "-",
    "--warning=no-file-changed",
    "--exclude=./.x1",
    "--exclude=./.git/objects/pack/*.pack",
    "-C",
    "/workspace",
  ];
  if (!paths || paths.length === 0) return [...base, "."];
  // Normalize: strip leading slash + leading ./ + drop empties.
  const cleaned = paths
    .map((p) => p.trim().replace(/^\/+/, "").replace(/^\.\/+/, ""))
    .filter((p) => p.length > 0 && p !== "." && !p.includes(".."));
  if (cleaned.length === 0) return [...base, "."];
  return [...base, ...cleaned];
}

async function captureExecStdout(
  exec: k8s.Exec,
  namespace: string,
  pod: string,
  container: string,
  command: string[],
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  const stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > maxBytes) {
      overflow = true;
      stdout.destroy();
      return;
    }
    chunks.push(chunk);
  });
  const stderrChunks: Buffer[] = [];
  const stderr = new PassThrough();
  stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  let status: k8s.V1Status | undefined;
  await execWithStatusWait(
    () =>
      exec.exec(
        namespace,
        pod,
        container,
        command,
        stdout,
        stderr,
        null,
        false,
        (s) => {
          status = s;
        },
      ),
    () => status,
  );

  if (overflow) {
    const err = new Error(`workspace exceeds size cap (${maxBytes} bytes); pass narrower paths`);
    (err as Error & { code: string }).code = "workspace_too_large";
    throw err;
  }
  if (status?.status === "Failure") {
    const stderrText = Buffer.concat(stderrChunks).toString("utf8").slice(0, 500);
    const err = new Error(`tar failed in child pod: ${status.message ?? "unknown"} ${stderrText}`);
    (err as Error & { code: string }).code = "tar_failed";
    throw err;
  }
  return Buffer.concat(chunks);
}

async function pipeTarIntoPod(
  exec: k8s.Exec,
  namespace: string,
  pod: string,
  container: string,
  destPath: string,
  tarBuffer: Buffer,
): Promise<void> {
  const stdin = Readable.from([tarBuffer]);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stderrChunks: Buffer[] = [];
  stdout.resume();
  stderr.on("data", (c: Buffer) => stderrChunks.push(c));
  let status: k8s.V1Status | undefined;
  await execWithStatusWait(
    () =>
      exec.exec(
        namespace,
        pod,
        container,
        ["tar", "xf", "-", "-C", destPath],
        stdout,
        stderr,
        stdin,
        false,
        (s) => {
          status = s;
        },
      ),
    () => status,
  );
  if (status?.status === "Failure") {
    const stderrText = Buffer.concat(stderrChunks).toString("utf8").slice(0, 500);
    const err = new Error(`tar extract failed in parent pod: ${status.message ?? "unknown"} ${stderrText}`);
    (err as Error & { code: string }).code = "tar_extract_failed";
    throw err;
  }
}

async function runExec(
  exec: k8s.Exec,
  namespace: string,
  pod: string,
  container: string,
  command: string[],
  stdout: Writable | null,
  stdin: ReadableT | null,
): Promise<void> {
  const out: Writable = stdout ?? new PassThrough();
  const stderr = new PassThrough();
  if (!stdout) (out as PassThrough).resume();
  stderr.resume();
  let status: k8s.V1Status | undefined;
  await execWithStatusWait(
    () =>
      exec.exec(
        namespace,
        pod,
        container,
        command,
        out,
        stderr,
        stdin,
        false,
        (s) => {
          status = s;
        },
      ),
    () => status,
  );
}

/**
 * Drive @kubernetes/client-node's Exec to completion without hanging when
 * the underlying WebSocket fails to emit `close`. Resolves as soon as the
 * server delivers a terminal V1Status via the status callback OR the
 * WebSocket closes cleanly. Rejects on socket error or hard timeout so a
 * stuck stream can't strand the request indefinitely.
 */
type WsLike = {
  on(ev: "close", cb: () => void): void;
  on(ev: "error", cb: (err: unknown) => void): void;
};

async function execWithStatusWait(
  start: () => Promise<WsLike | unknown>,
  getStatus: () => k8s.V1Status | undefined,
  timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(
      () => done(new Error(`k8s exec timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const poller = setInterval(() => {
      if (getStatus() !== undefined) done();
    }, 50);
    start()
      .then((ws) => {
        const w = ws as WsLike;
        w.on("close", () => done());
        w.on("error", (err: unknown) => done(err as Error));
      })
      .catch((err) => done(err as Error));
  });
}

async function countFiles(
  exec: k8s.Exec,
  namespace: string,
  pod: string,
  dir: string,
): Promise<number> {
  const stdoutChunks: Buffer[] = [];
  const stdout = new PassThrough();
  stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  await runExec(
    exec,
    namespace,
    pod,
    "agent",
    ["sh", "-c", `find ${shQuote(dir)} -type f 2>/dev/null | wc -l`],
    stdout,
    null,
  );
  const out = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : 0;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
