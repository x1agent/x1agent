import { useCallback, useState } from "react";

/**
 * Per-attachment lifecycle state. The UI cares about three resolved
 * states (uploading / ready / failed); error carries the human-facing
 * reason when the upload didn't make it.
 */
export type UploadStatus = "uploading" | "ready" | "failed";

export interface Attachment {
  /** Local-only id used as a React key before the server has minted
   *  one. Becomes the real upload_id once /init succeeds. */
  key: string;
  uploadId: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
  status: UploadStatus;
  error: string | null;
}

interface InitResponse {
  upload_id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: string;
}

const API_BASE =
  (typeof window !== "undefined" &&
    (import.meta as unknown as { env?: { PUBLIC_API_URL?: string } }).env
      ?.PUBLIC_API_URL) ||
  "";

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * Hook used by composer surfaces to wire drag/drop into the
 * `/api/uploads` backend. Returns the current attachments + the
 * imperative actions (add files, remove an attachment). The composer
 * renders pills out of `attachments` and treats `isUploading` as the
 * cue for the animated border.
 *
 * Failure mode: any error on /init, PUT, or /complete flips that
 * specific attachment to `failed`; the rest of the batch keeps going.
 *
 * Lifecycle on remove:
 *   - status === "uploading": local-only drop (no server state yet)
 *   - status === "ready": DELETE /api/uploads/:id so the row is
 *     marked deleted server-side
 *   - status === "failed": local-only drop
 */
export function useUploadAttachments(sessionId?: string | null) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const isUploading = attachments.some((a) => a.status === "uploading");

  const update = useCallback(
    (key: string, patch: Partial<Attachment>) => {
      setAttachments((prev) =>
        prev.map((a) => (a.key === key ? { ...a, ...patch } : a)),
      );
    },
    [],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      const next: Attachment[] = list.map((file, idx) => ({
        key: `${Date.now()}-${idx}-${file.name}`,
        uploadId: null,
        filename: file.name,
        mime: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "uploading",
        error: null,
      }));
      setAttachments((prev) => [...prev, ...next]);

      await Promise.all(
        next.map(async (att, i) => {
          const file = list[i]!;
          try {
            const initRes = await fetch(apiUrl("/api/uploads/init"), {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filename: att.filename,
                mime_hint: att.mime,
                size_bytes: att.sizeBytes,
                session_id: sessionId ?? null,
              }),
            });
            if (!initRes.ok) {
              const body = await initRes.json().catch(() => ({}));
              throw new Error(body.error || `init failed (${initRes.status})`);
            }
            const init: InitResponse = await initRes.json();

            // PUT the bytes. The presigned URL is bound to method +
            // content-type + content-length per X1A-96's security
            // model — match exactly or the URL signature fails.
            const putRes = await fetch(init.upload_url, {
              method: init.method,
              headers: init.headers,
              body: file,
            });
            if (!putRes.ok) {
              throw new Error(`upload PUT failed (${putRes.status})`);
            }

            // Tell the server we're done — server-side MIME sniff
            // happens here and flips the row from `pending` to `ready`.
            const completeRes = await fetch(
              apiUrl(`/api/uploads/${init.upload_id}/complete`),
              {
                method: "POST",
                credentials: "include",
              },
            );
            if (!completeRes.ok) {
              const body = await completeRes.json().catch(() => ({}));
              throw new Error(
                body.error || `complete failed (${completeRes.status})`,
              );
            }

            update(att.key, {
              status: "ready",
              uploadId: init.upload_id,
            });
          } catch (err) {
            update(att.key, {
              status: "failed",
              error: (err as Error).message || "upload failed",
            });
          }
        }),
      );
    },
    [sessionId, update],
  );

  const remove = useCallback(
    async (key: string) => {
      const att = attachments.find((a) => a.key === key);
      setAttachments((prev) => prev.filter((a) => a.key !== key));
      if (att?.status === "ready" && att.uploadId) {
        // Fire-and-forget — DELETE is idempotent and the UI has
        // already committed to the pill being gone.
        void fetch(apiUrl(`/api/uploads/${att.uploadId}`), {
          method: "DELETE",
          credentials: "include",
        }).catch(() => {});
      }
    },
    [attachments],
  );

  const clear = useCallback(() => {
    setAttachments([]);
  }, []);

  /** IDs of attachments that finished uploading — the composer uses
   *  these on submit to either include them as inline tokens or send
   *  them out-of-band. */
  const readyUploadIds = attachments
    .filter((a) => a.status === "ready" && a.uploadId)
    .map((a) => a.uploadId as string);

  return {
    attachments,
    isUploading,
    readyUploadIds,
    addFiles,
    remove,
    clear,
  };
}
