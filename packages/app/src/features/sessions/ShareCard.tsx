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

type ShareType =
  | "image"
  | "svg"
  | "site"
  | "csv"
  | "json"
  | "archive"
  | "code"
  | "document"
  | "file";

interface ShareFileEntry {
  path: string;
  size: number;
  content_type: string;
}

interface AgentSharePayload {
  share_id: string;
  share_type: ShareType;
  title: string;
  path: string;
  files: ShareFileEntry[];
  total_size: number;
  entry_point?: string | null;
}

function shareUrl(
  workspaceSlug: string,
  sessionId: string,
  shareId: string,
  path = "",
): string {
  // Cookies ride: localhost:4322 and localhost:30001 share the same
  // registrable domain so a SameSite=Lax session cookie is sent on
  // top-level navigations (iframe src, <a download> clicks) without
  // any extra work. fetch() calls in this file use
  // credentials: "include" so they're covered too; <img> tags get
  // crossOrigin="use-credentials" below. The api's CORS block already
  // allows credentials from the app origin.
  return `${API_BASE}/api/workspaces/${workspaceSlug}/sessions/${sessionId}/shares/${shareId}/${path}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TYPE_ICONS: Record<ShareType, typeof FileText> = {
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
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-medium text-zinc-100">{title}</span>
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

interface SubProps {
  payload: AgentSharePayload;
  workspaceSlug: string;
  sessionId: string;
  maximized?: boolean;
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
  const downloadPath = payload.entry_point || payload.files[0]?.path || "";
  const downloadUrl = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    downloadPath,
  );

  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-zinc-400" />
        <span className="truncate text-sm font-medium text-zinc-100">
          {payload.title}
        </span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {payload.share_type}
        </Badge>
        <span className="shrink-0 text-[10px] text-zinc-500">
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
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
  );
  return (
    <img
      src={src}
      alt={payload.title}
      crossOrigin="use-credentials"
      className="max-w-full rounded-md border border-zinc-800"
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
  const src = useMemo(
    () =>
      shareUrl(
        workspaceSlug,
        sessionId,
        payload.share_id,
        payload.files[0]?.path || "",
      ),
    [workspaceSlug, sessionId, payload.share_id, payload.files],
  );

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then(setSvg)
      .catch(() => setSvg(""));
  }, [src]);

  if (svg === null)
    return <div className="text-xs text-zinc-500">Loading SVG…</div>;
  return (
    <div
      className="max-w-full overflow-auto rounded-md border border-zinc-800 bg-white p-2"
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
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.entry_point || "index.html",
  );
  return (
    <iframe
      src={src}
      className="w-full rounded-md border border-zinc-800 bg-white"
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
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
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
    return <div className="text-xs text-zinc-500">Loading CSV…</div>;

  const [headers, ...data] = rows;
  return (
    <div
      className="overflow-auto rounded-md border border-zinc-800"
      style={{ maxHeight: maximized ? "calc(100vh - 50px)" : "400px" }}
    >
      <table className="w-full text-xs text-zinc-100">
        <thead className="sticky top-0 bg-zinc-900">
          <tr>
            {(headers ?? []).map((h, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-zinc-800 px-3 py-2 text-left font-medium text-zinc-400"
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
              className="border-b border-zinc-900 last:border-0 hover:bg-zinc-900/40"
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
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
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
    return <div className="text-xs text-zinc-500">Loading JSON…</div>;

  return (
    <div
      className="overflow-auto rounded-md border border-zinc-800 bg-[#1e1e1e] p-3"
      style={{ maxHeight: maximized ? "calc(100vh - 50px)" : "400px" }}
    >
      <JsonView data={data as object} style={darkStyles} />
    </div>
  );
}

// ── Code ─────────────────────────────────────────────────────────

function CodeShare({ payload, workspaceSlug, sessionId }: SubProps) {
  const [content, setContent] = useState<string | null>(null);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
  );

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent(""));
  }, [src]);

  if (content === null)
    return <div className="text-xs text-zinc-500">Loading…</div>;
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100">
      {content}
    </pre>
  );
}

// ── Document (markdown) ──────────────────────────────────────────

function DocumentShare({ payload, workspaceSlug, sessionId }: SubProps) {
  const [content, setContent] = useState<string | null>(null);
  const src = shareUrl(
    workspaceSlug,
    sessionId,
    payload.share_id,
    payload.files[0]?.path || "",
  );

  useEffect(() => {
    fetch(src, { credentials: "include" })
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent(""));
  }, [src]);

  if (content === null)
    return <div className="text-xs text-zinc-500">Loading…</div>;
  return (
    <div className="max-h-96 overflow-auto text-sm text-zinc-100">
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
  );
  return (
    <a
      href={downloadUrl}
      download
      target="_blank"
      rel="noopener"
      className="flex items-center gap-3 rounded-md border border-zinc-800 p-4 transition-colors hover:bg-zinc-900/50"
    >
      <FileArchive className="size-8 text-zinc-400" />
      <div>
        <div className="text-sm font-medium text-zinc-100">
          {payload.files[0]?.path || "archive"}
        </div>
        <div className="text-xs text-zinc-500">
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
  );
  return (
    <a
      href={downloadUrl}
      download
      target="_blank"
      rel="noopener"
      className="flex items-center gap-3 rounded-md border border-zinc-800 p-4 transition-colors hover:bg-zinc-900/50"
    >
      <FileText className="size-8 text-zinc-400" />
      <div>
        <div className="text-sm font-medium text-zinc-100">
          {payload.files[0]?.path || "file"}
        </div>
        <div className="text-xs text-zinc-500">
          {formatSize(payload.total_size)} — Click to download
        </div>
      </div>
    </a>
  );
}

// ── Main ─────────────────────────────────────────────────────────

function renderBody(props: SubProps) {
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
          {renderBody({ ...sub, maximized: true })}
        </div>
      </MaximizeOverlay>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="rounded-lg border border-zinc-800 p-4">
        <ShareHeader
          payload={payload}
          workspaceSlug={workspaceSlug}
          sessionId={sessionId}
          canMaximize={canMaximize}
          maximized={maximized}
          onToggleMaximize={() => setMaximized(!maximized)}
        />
        {renderBody(sub)}
      </div>
    </div>
  );
}
