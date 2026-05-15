import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "./markdown-components";
import {
  Braces,
  Download,
  FileArchive,
  FileCode,
  FileText,
  Globe,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Table as TableIcon,
  X,
} from "lucide-react";
import { JsonView, darkStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import type { SessionEventDTO } from "@x1agent/shared";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { API_BASE } from "../../lib/api";

/**
 * Inline renderer for `agent.share` events. A share is a workspace
 * file (or folder) that the agent published for the user to view or
 * download. The agent side is driven by the `share` MCP tool; the
 * sidecar packages the bytes, uploads them to durable storage, and
 * emits this event with a typed payload.
 *
 * One top-level share_type selects one of nine renderers below. CSV,
 * JSON, and site shares support a maximize overlay for reading at full
 * viewport. Everything else is shown inline.
 */

export type ShareType =
  | "image"
  | "svg"
  | "site"
  | "csv"
  | "json"
  | "archive"
  | "code"
  | "document"
  | "file";

export interface ShareFileEntry {
  path: string;
  size: number;
  content_type: string;
}

export interface AgentSharePayload {
  share_id: string;
  share_type: ShareType;
  title: string;
  path: string;
  files: ShareFileEntry[];
  total_size: number;
  entry_point?: string | null;
  /**
   * Milliseconds since epoch at the moment the sidecar finished
   * persisting this revision. Used as a content cache-buster
   * (`?v=<updated_at_ms>`) so an in-place share update renders new
   * bytes instead of the cached version. See X1A-92.
   *
   * Optional because older `agent.share` events on disk predate the
   * field. Renderers fall back to the event's seq/timestamp from the
   * surrounding SessionEventDTO when missing.
   */
  updated_at_ms?: number;
}

export function shareUrl(
  workspaceSlug: string,
  sessionId: string,
  shareId: string,
  path = "",
  version?: number | string | null,
): string {
  // Cookies ride: localhost:4322 and localhost:30001 share the same
  // registrable domain so a SameSite=Lax session cookie is sent on
  // top-level navigations (iframe src, <a download> clicks) without
  // any extra work. fetch() calls in this file use
  // credentials: "include" so they're covered too; <img> tags get
  // crossOrigin="use-credentials" below. The api's CORS block already
  // allows credentials from the app origin.
  //
  // `version` appends a `?v=<n>` cache-buster. When an agent updates
  // an existing share (same share_id, new file bytes), bumping the
  // version forces <img>, <iframe>, and fetch() to bypass the
  // browser's HTTP cache and pull the new bytes. See X1A-92.
  const url = `${API_BASE}/api/workspaces/${workspaceSlug}/sessions/${sessionId}/shares/${shareId}/${path}`;
  if (version === undefined || version === null) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(String(version))}`;
}

/**
 * Pick the freshest cache-buster signal we have for a share payload.
 *
 * Order of preference:
 *   1. The payload's own `updated_at_ms` (set by the sidecar on every
 *      publish — see X1A-92). Newest sidecar; most reliable.
 *   2. The surrounding event's `seq` (monotonically increasing per
 *      session — distinguishes events even on legacy payloads).
 *   3. Nothing — render without `?v=`.
 *
 * Either signal works as a cache-key because both are guaranteed to
 * change between an original share and an update with the same
 * share_id.
 */
export function shareContentVersion(
  payload: AgentSharePayload,
  fallbackSeq?: number,
): number | undefined {
  if (typeof payload.updated_at_ms === "number" && payload.updated_at_ms > 0) {
    return payload.updated_at_ms;
  }
  if (typeof fallbackSeq === "number") return fallbackSeq;
  return undefined;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const TYPE_ICONS: Record<ShareType, typeof FileText> = {
  image: ImageIcon,
  svg: ImageIcon,
  site: Globe,
  csv: TableIcon,
  json: Braces,
  archive: FileArchive,
  code: FileCode,
  document: FileText,
  file: FileText,
};

// ── Maximize overlay ─────────────────────────────────────────────

function MaximizeOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/95">
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-2">
        <span className="text-sm font-medium text-fg">{title}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────

export interface SubProps {
  payload: AgentSharePayload;
  workspaceSlug: string;
  sessionId: string;
  maximized?: boolean;
  /**
   * Caller is a flex/grid parent that already provides full available
   * height and its own scroll region (e.g. the right-rail
   * ArtifactPanel). Renderers that would otherwise impose a fixed
   * `max-h-*` should drop that cap and let the parent scroll, so long
   * content isn't truncated inside a tiny inner box. The inline
   * `ShareCard` in the chat stream omits this and keeps its bounded
   * preview height.
   */
  fillParent?: boolean;
}

function ShareHeader({
  payload,
  workspaceSlug,
  sessionId,
  canMaximize,
  maximized,
  onToggleMaximize,
}: SubProps & {
  canMaximize?: boolean;
  onToggleMaximize?: () => void;
}) {
  const Icon = TYPE_ICONS[payload.share_type] ?? FileText;
  // Whole-share zip — see ArtifactPanel header for the same rationale.
  const downloadUrl = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    "_download.zip",
    shareContentVersion(payload),
  );

  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-fg-muted" />
        <span className="truncate text-sm font-medium text-fg">
          {payload.title}
        </span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {payload.share_type}
        </Badge>
        <span className="shrink-0 text-[10px] text-fg-faint">
          {formatSize(payload.total_size)}
          {payload.files.length > 1 && ` · ${payload.files.length} files`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canMaximize && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleMaximize}
            title={maximized ? "Minimize" : "Maximize"}
          >
            {maximized ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </Button>
        )}
        <a href={downloadUrl} download target="_blank" rel="noopener">
          <Button variant="ghost" size="sm" title="Download">
            <Download className="size-3.5" />
          </Button>
        </a>
      </div>
    </div>
  );
}

// ── Image ────────────────────────────────────────────────────────

function ImageShare({ payload, workspaceSlug, sessionId }: SubProps) {
  const version = shareContentVersion(payload);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
    version,
  );
  return (
    <img
      src={src}
      alt={payload.title}
      crossOrigin="use-credentials"
      className="max-w-full rounded-md border border-border-soft"
      style={{ maxHeight: "500px", objectFit: "contain" }}
    />
  );
}

// ── SVG ──────────────────────────────────────────────────────────
//
// Fetched as text and inlined via dangerouslySetInnerHTML so it can
// scale to the container. The server sets image/svg+xml so the
// fetched response renders correctly; we inline the markup so vector
// behavior (scaling, interactivity) is preserved.

function SvgShare({ payload, workspaceSlug, sessionId }: SubProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const version = shareContentVersion(payload);
  const src = useMemo(
    () =>
      shareUrl(
        workspaceSlug,
        sessionId,
        payload.share_id,
        payload.files[0]?.path || "",
        version,
      ),
    [workspaceSlug, sessionId, payload.share_id, payload.files, version],
  );

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then(setSvg)
      .catch(() => setSvg(""));
  }, [src]);

  if (svg === null)
    return <div className="text-xs text-fg-faint">Loading SVG…</div>;
  return (
    <div
      className="max-w-full overflow-auto rounded-md border border-border-soft bg-white p-2"
      style={{ maxHeight: "500px" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// ── Site (HTML) ─────────────────────────────────────────────────

function SiteShare({
  payload,
  workspaceSlug,
  sessionId,
  maximized,
}: SubProps) {
  const version = shareContentVersion(payload);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.entry_point || "index.html",
    version,
  );
  return (
    <iframe
      src={src}
      className="w-full rounded-md border border-border-soft bg-white"
      style={{ height: maximized ? "calc(100vh - 50px)" : "500px" }}
      sandbox="allow-scripts allow-same-origin"
      title={payload.title}
    />
  );
}

// ── CSV ──────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function CsvShare({
  payload,
  workspaceSlug,
  sessionId,
  maximized,
}: SubProps) {
  const [rows, setRows] = useState<string[][]>([]);
  const version = shareContentVersion(payload);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
    version,
  );

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then((text) => {
        const parsed = text
          .trim()
          .split("\n")
          .map((line) => parseCsvLine(line));
        setRows(parsed);
      })
      .catch(() => setRows([]));
  }, [src]);

  if (rows.length === 0)
    return <div className="text-xs text-fg-faint">Loading CSV…</div>;

  const [headers, ...data] = rows;
  return (
    <div
      className="overflow-auto rounded-md border border-border-soft"
      style={{ maxHeight: maximized ? "calc(100vh - 50px)" : "400px" }}
    >
      <table className="w-full text-xs text-fg">
        <thead className="sticky top-0 bg-bg-elevated">
          <tr>
            {(headers ?? []).map((h, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-border-soft px-3 py-2 text-left font-medium text-fg-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-border-soft last:border-0 hover:bg-bg-elevated/40"
            >
              {row.map((cell, ci) => (
                <td key={ci} className="whitespace-nowrap px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── JSON ─────────────────────────────────────────────────────────

function JsonShare({
  payload,
  workspaceSlug,
  sessionId,
  maximized,
}: SubProps) {
  const [data, setData] = useState<unknown>(null);
  const version = shareContentVersion(payload);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
    version,
  );
  const isJsonl = (payload.files[0]?.path || "").endsWith(".jsonl");

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then((text) => {
        if (isJsonl) {
          const lines = text
            .trim()
            .split("\n")
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return l;
              }
            });
          setData(lines);
        } else {
          setData(JSON.parse(text));
        }
      })
      .catch(() => setData({}));
  }, [src, isJsonl]);

  if (data === null)
    return <div className="text-xs text-fg-faint">Loading JSON…</div>;

  return (
    <div
      className="overflow-auto rounded-md border border-border-soft bg-[#1e1e1e] p-3"
      style={{ maxHeight: maximized ? "calc(100vh - 50px)" : "400px" }}
    >
      <JsonView data={data as object} style={darkStyles} />
    </div>
  );
}

// ── Code ─────────────────────────────────────────────────────────

function CodeShare({ payload, workspaceSlug, sessionId }: SubProps) {
  const [content, setContent] = useState<string | null>(null);
  const version = shareContentVersion(payload);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
    version,
  );

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent(""));
  }, [src]);

  if (content === null)
    return <div className="text-xs text-fg-faint">Loading…</div>;
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-bg-elevated p-3 text-xs text-fg">
      {content}
    </pre>
  );
}

// ── Document (markdown) ──────────────────────────────────────────

function DocumentShare({
  payload,
  workspaceSlug,
  sessionId,
  fillParent,
}: SubProps) {
  const [content, setContent] = useState<string | null>(null);
  const version = shareContentVersion(payload);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
    version,
  );

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent(""));
  }, [src]);

  if (content === null)
    return <div className="text-xs text-fg-faint">Loading…</div>;
  // In the flyout (ArtifactPanel) the wrapper is already a
  // `flex-1 overflow-auto` scroll region that fills the viewport, so a
  // local 384px scroller here just clipped long markdown into a tiny
  // inner box — X1A-19. With `fillParent` we render a plain block and
  // let the parent own the scroll: short docs sit naturally, long docs
  // scroll the full viewport with a visible scrollbar. The inline
  // ShareCard (no fillParent) keeps its bounded preview.
  const cls = fillParent
    ? "text-sm text-fg"
    : "max-h-96 overflow-auto text-sm text-fg";
  return (
    <div className={cls} data-testid="document-share">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </Markdown>
    </div>
  );
}

// ── Archive ──────────────────────────────────────────────────────

function ArchiveShare({ payload, workspaceSlug, sessionId }: SubProps) {
  const downloadUrl = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
    shareContentVersion(payload),
  );
  return (
    <a
      href={downloadUrl}
      download
      target="_blank"
      rel="noopener"
      className="flex items-center gap-3 rounded-md border border-border-soft p-4 transition-colors hover:bg-bg-elevated/50"
    >
      <FileArchive className="size-8 text-fg-muted" />
      <div>
        <div className="text-sm font-medium text-fg">
          {payload.files[0]?.path || "archive"}
        </div>
        <div className="text-xs text-fg-faint">
          {formatSize(payload.total_size)} — Click to download
        </div>
      </div>
    </a>
  );
}

// ── Generic file ─────────────────────────────────────────────────

function GenericFileShare({ payload, workspaceSlug, sessionId }: SubProps) {
  const downloadUrl = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
    shareContentVersion(payload),
  );
  return (
    <a
      href={downloadUrl}
      download
      target="_blank"
      rel="noopener"
      className="flex items-center gap-3 rounded-md border border-border-soft p-4 transition-colors hover:bg-bg-elevated/50"
    >
      <FileText className="size-8 text-fg-muted" />
      <div>
        <div className="text-sm font-medium text-fg">
          {payload.files[0]?.path || "file"}
        </div>
        <div className="text-xs text-fg-faint">
          {formatSize(payload.total_size)} — Click to download
        </div>
      </div>
    </a>
  );
}

// ── Main ─────────────────────────────────────────────────────────

export function renderShareBody(props: SubProps) {
  const { payload } = props;
  switch (payload.share_type) {
    case "image":
      return <ImageShare {...props} />;
    case "svg":
      return <SvgShare {...props} />;
    case "site":
      return <SiteShare {...props} />;
    case "csv":
      return <CsvShare {...props} />;
    case "json":
      return <JsonShare {...props} />;
    case "code":
      return <CodeShare {...props} />;
    case "document":
      return <DocumentShare {...props} />;
    case "archive":
      return <ArchiveShare {...props} />;
    case "file":
    default:
      return <GenericFileShare {...props} />;
  }
}

export default function ShareCard({
  event,
  workspaceSlug,
  sessionId,
}: {
  event: SessionEventDTO;
  workspaceSlug: string;
  sessionId: string;
}) {
  const payload = (event.payload ?? {}) as AgentSharePayload;
  const [maximized, setMaximized] = useState(false);
  const canMaximize = ["site", "csv", "json"].includes(payload.share_type);

  if (!payload.share_id) return null;

  const sub: SubProps = { payload, workspaceSlug, sessionId };

  if (maximized) {
    return (
      <MaximizeOverlay
        title={payload.title}
        onClose={() => setMaximized(false)}
      >
        <div className="p-4">
          <ShareHeader
            payload={payload}
            workspaceSlug={workspaceSlug}
            sessionId={sessionId}
            canMaximize
            maximized
            onToggleMaximize={() => setMaximized(false)}
          />
          {renderShareBody({ ...sub, maximized: true })}
        </div>
      </MaximizeOverlay>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="rounded-lg border border-border-soft p-4">
        <ShareHeader
          payload={payload}
          workspaceSlug={workspaceSlug}
          sessionId={sessionId}
          canMaximize={canMaximize}
          maximized={maximized}
          onToggleMaximize={() => setMaximized(!maximized)}
        />
        {renderShareBody(sub)}
      </div>
    </div>
  );
}
