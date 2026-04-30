import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { apiFetch } from "../../lib/api";

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsdEstimate: number;
}
interface ByAgent extends Totals {
  agentId: string | null;
  agentName: string | null;
  agentSlug: string | null;
}
interface ByModel extends Totals {
  model: string;
}
interface RollupResponse {
  range: { since: string; until: string };
  totals: Totals;
  byAgent: ByAgent[];
  byModel: ByModel[];
  byDay: unknown[]; // not rendered here yet
}

interface Props {
  workspaceSlug: string;
  /**
   * Hide the panel entirely for non-admin viewers — the API rejects
   * with 403 anyway, but rendering an empty panel for a member is
   * worse UX than not showing it at all.
   */
  canManage: boolean;
}

const NUMBER = new Intl.NumberFormat("en-US");
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  // Most rows here are pennies; show 4 decimals so dust doesn't read as $0.
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function TokenUsagePanel({ workspaceSlug, canManage }: Props) {
  const [data, setData] = useState<RollupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<RollupResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceSlug)}/token-usage`,
    )
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, canManage]);

  if (!canManage) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token usage — this month</CardTitle>
        <CardDescription>
          Captured per agent turn. Cost is an estimate from current public
          Anthropic pricing; treat as directional, not invoice-exact.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && (
          <div className="text-sm text-zinc-400">Loading…</div>
        )}
        {error && (
          <div className="text-sm text-red-400">Failed to load: {error}</div>
        )}
        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <Stat label="Estimated cost" value={USD.format(data.totals.costUsdEstimate)} highlight />
              <Stat label="Input tokens"  value={NUMBER.format(data.totals.inputTokens)} />
              <Stat label="Output tokens" value={NUMBER.format(data.totals.outputTokens)} />
              <Stat
                label="Cache (read / write)"
                value={`${NUMBER.format(data.totals.cacheReadInputTokens)} / ${NUMBER.format(data.totals.cacheCreationInputTokens)}`}
              />
            </div>

            {data.byAgent.length === 0 ? (
              <div className="text-sm text-zinc-400">
                No agent activity yet this month.
              </div>
            ) : (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
                  By agent
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Input</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byAgent.map((a) => (
                      <TableRow key={a.agentId ?? "__null__"}>
                        <TableCell>
                          {a.agentSlug ? (
                            <a
                              href={`/workspaces/${workspaceSlug}/agents/${a.agentSlug}`}
                              className="text-zinc-100 hover:underline"
                            >
                              {a.agentName ?? a.agentSlug}
                            </a>
                          ) : (
                            <span className="text-zinc-500">(deleted agent)</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {USD.format(a.costUsdEstimate)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-zinc-400">
                          {NUMBER.format(a.inputTokens)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-zinc-400">
                          {NUMBER.format(a.outputTokens)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {data.byModel.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
                  By model
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">Input</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byModel.map((m) => (
                      <TableRow key={m.model}>
                        <TableCell className="font-mono text-xs">{m.model}</TableCell>
                        <TableCell className="text-right font-mono">
                          {USD.format(m.costUsdEstimate)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-zinc-400">
                          {NUMBER.format(m.inputTokens)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-zinc-400">
                          {NUMBER.format(m.outputTokens)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div
        className={
          highlight
            ? "mt-1 text-lg font-semibold text-zinc-100"
            : "mt-1 text-base font-mono text-zinc-200"
        }
      >
        {value}
      </div>
    </div>
  );
}
