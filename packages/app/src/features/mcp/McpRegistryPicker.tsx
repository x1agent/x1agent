import { useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { Input } from "../../components/ui/input";
import { Badge } from "../../components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  MCP_SEED,
  type McpSeedEntry,
  searchSeed,
  simpleIconUrl,
} from "./seed";

interface Props {
  /**
   * Slugs already in the catalog so the picker can dim those rows
   * (still clickable so the operator can re-install / re-discover
   * if the original failed, but with an "Installed" badge).
   */
  existingSlugs: readonly string[];
  /**
   * Called when the operator picks an entry. The parent fills its
   * existing add-form with the entry's defaults — operator confirms
   * and saves through the normal flow.
   */
  onPick(entry: McpSeedEntry): void;
}

const KIND_LABEL: Record<McpSeedEntry["kind"], string> = {
  remote_oauth: "Remote OAuth",
  command: "Stdio (command)",
  image: "Stdio (image)",
};

const KIND_TONE: Record<McpSeedEntry["kind"], string> = {
  remote_oauth:
    "bg-violet-500/15 text-violet-300 ring-violet-500/30 light:text-violet-700 light:bg-violet-500/12 light:ring-violet-500/30",
  command:
    "bg-blue-500/15 text-blue-300 ring-blue-500/30 light:text-blue-700 light:bg-blue-500/12 light:ring-blue-500/30",
  image:
    "bg-amber-500/15 text-amber-300 ring-amber-500/30 light:text-amber-700 light:bg-amber-500/15 light:ring-amber-500/30",
};

/**
 * Search-and-install picker for the MCP catalog. Renders above the
 * existing free-form add-form on the workspace MCP page. Type a
 * provider name (linear, notion, …) → click → form pre-fills →
 * operator confirms + clicks Save through the normal flow.
 *
 * Backed entirely by the in-repo seed in seed.ts. No registry call,
 * no external API dependency — works offline and never breaks if a
 * third-party registry pivots.
 */
export function McpRegistryPicker({ existingSlugs, onPick }: Props) {
  const [query, setQuery] = useState("");
  const installed = useMemo(
    () => new Set(existingSlugs.map((s) => s.toLowerCase())),
    [existingSlugs],
  );
  const results = useMemo(() => searchSeed(query), [query]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Browse MCP servers</CardTitle>
        <CardDescription>
          Pick a known provider to pre-fill the add form below — review
          and click Save to install. Anything outside the curated list
          can still be added through Custom MCP at the bottom of the
          form.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-faint" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${MCP_SEED.length} known servers — Linear, Notion, GitHub, …`}
            className="pl-9"
            autoComplete="off"
          />
        </div>

        {results.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-soft px-4 py-8 text-center text-sm text-fg-faint">
            No matches in the curated list. Use Custom MCP at the bottom
            of the form to register a server by URL or command.
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {results.map((entry) => {
              const isInstalled = installed.has(entry.slug);
              return (
                <li key={entry.slug}>
                  <button
                    type="button"
                    onClick={() => onPick(entry)}
                    className="group flex w-full items-start gap-3 rounded-md border border-border-soft bg-bg p-3 text-left transition-colors hover:border-border-strong hover:bg-bg-elevated/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400"
                  >
                    <SeedLogo entry={entry} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">
                          {entry.display_name}
                        </span>
                        {isInstalled && (
                          <Badge variant="secondary" className="text-[10px]">
                            Installed
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-fg-faint">
                        {entry.description}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span
                          className={`inline-flex rounded-sm px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${KIND_TONE[entry.kind]}`}
                        >
                          {KIND_LABEL[entry.kind]}
                        </span>
                        {entry.kind === "remote_oauth" && !entry.mcp_url && (
                          <span className="rounded-sm bg-bg-muted/80 px-1.5 py-0.5 text-[10px] text-fg-muted">
                            URL needed
                          </span>
                        )}
                        <a
                          href={entry.homepage}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="ml-auto inline-flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-muted"
                          aria-label={`Open ${entry.display_name} homepage`}
                        >
                          docs <ExternalLink className="size-3" />
                        </a>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Brand logo via Simple Icons CDN (CC0). Falls back to a neutral
 * tile with the entry's first letter when no `simple_icon` slug is
 * configured or the SVG fails to load (e.g. that brand isn't in the
 * library yet).
 */
function SeedLogo({ entry }: { entry: McpSeedEntry }) {
  const [failed, setFailed] = useState(false);
  if (entry.simple_icon && !failed) {
    return (
      <img
        src={simpleIconUrl(entry.simple_icon)}
        alt=""
        className="mt-0.5 size-7 shrink-0 rounded-sm bg-zinc-100/95 p-1"
        onError={() => setFailed(true)}
        loading="lazy"
      />
    );
  }
  return (
    <div
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-sm bg-bg-muted text-xs font-semibold text-fg-muted"
      aria-hidden="true"
    >
      {entry.display_name.charAt(0).toUpperCase()}
    </div>
  );
}

/**
 * Imperative API: for a picker hosted in a panel that already has an
 * add-form, call this with the entry to compute the field values the
 * form should adopt. Keeps the picker stateless about the form
 * layout — the parent decides how to apply the suggestion.
 */
export interface SeedFormDefaults {
  name: string;
  display_name: string;
  description: string;
  /** Catalog kind in the panel's enum (image | command | remote_oauth). */
  kind: "image" | "command" | "remote_oauth";
  url: string;
  command: string;
  args: string;
  image: string;
}

export function defaultsFromSeed(entry: McpSeedEntry): SeedFormDefaults {
  // The panel uses a slightly different `kind` enum ("image" |
  // "command" | "remote_oauth") than the API ("stdio" | "remote_oauth")
  // — the panel splits stdio-by-image and stdio-by-command in the UI.
  // Map seed kind onto whichever the panel expects.
  const panelKind: SeedFormDefaults["kind"] =
    entry.kind === "remote_oauth"
      ? "remote_oauth"
      : entry.kind === "image"
        ? "image"
        : "command";
  return {
    name: entry.slug,
    display_name: entry.display_name,
    description: entry.description,
    kind: panelKind,
    url: entry.mcp_url ?? "",
    command: entry.command ?? "",
    args: (entry.args ?? []).join("\n"),
    image: entry.image ?? "",
  };
}
