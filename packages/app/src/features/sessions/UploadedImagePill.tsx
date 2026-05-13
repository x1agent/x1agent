import { useEffect, useState } from "react";
import { Image as ImageIcon, X } from "lucide-react";
import { apiFetch } from "../../lib/api";

interface Props {
  uploadId: string;
  /**
   * When true, render a small X next to the metadata that DELETEs
   * the upload server-side and removes the pill from the DOM. Used
   * on user-authored timeline pills so the user can recall an
   * attachment after submit. Composer pills (pre-submit) wire their
   * own removal via the upload hook.
   */
  deletable?: boolean;
}

interface UploadMeta {
  upload_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  status: string;
  created_at: string;
  expires_at: string;
}

/**
 * Inline pill for an `[image: <id>]` token in a user message. Visual
 * shape mirrors `SharePill`'s chrome (rounded border, inline-flex,
 * icon + label + size) so timeline rhythm reads as one family. The
 * caller positions us (right-aligned in user bubbles via the parent's
 * flex justify-end).
 *
 * Metadata is fetched lazily via `GET /api/uploads/:id` so the pill
 * shows the real filename + size. While loading, the id is the label
 * — short truncation keeps the row narrow; the title attribute holds
 * the full id for power users.
 */
export function UploadedImagePill({ uploadId }: Props) {
  const [meta, setMeta] = useState<UploadMeta | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch<UploadMeta>(`/api/uploads/${uploadId}`)
      .then((u) => {
        if (alive) setMeta(u);
      })
      .catch(() => {
        if (alive) setErrored(true);
      });
    return () => {
      alive = false;
    };
  }, [uploadId]);

  const label = meta?.filename ?? `${uploadId.slice(0, 8)}…`;
  const sizeLabel = meta ? formatSize(meta.size_bytes) : null;
  const tip = meta
    ? `${meta.filename} · ${meta.mime} · ${formatSize(meta.size_bytes)}`
    : uploadId;

  return (
    <span
      className="inline-flex max-w-full items-center gap-2 rounded-md border border-border-soft bg-bg px-2.5 py-1.5 text-left text-sm text-fg-muted"
      title={tip}
      data-testid="uploaded-image-pill"
      data-upload-id={uploadId}
    >
      <ImageIcon className="size-3.5 shrink-0 text-fg-muted" />
      <span className="truncate font-medium">{label}</span>
      <span className="shrink-0 rounded bg-bg-muted/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
        upload
      </span>
      {sizeLabel && (
        <span className="shrink-0 text-[11px] text-fg-faint">{sizeLabel}</span>
      )}
      {errored && (
        <span className="shrink-0 text-[11px] text-red-500">unavailable</span>
      )}
    </span>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
