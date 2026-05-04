import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDown, ArrowUp, Download, Minus } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import {
  useAnalyticsStore,
  type AnalyticsRollup,
  type TokenUsageByAgent,
  type TriggerSource,
} from "../../stores/analyticsStore";
import { RangePicker } from "./RangePicker";
import { downloadCsv, rollupToCsv } from "./csv";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

const TRIGGER_COLORS: Record<TriggerSource, string> = {
  user: "#10b981", // emerald
  scheduler: "#f59e0b", // amber
  agent: "#8b5cf6", // violet
};
const TRIGGER_LABELS: Record<TriggerSource, string> = {
  user: "Manual",
  scheduler: "Scheduled",
  agent: "Agent-spawned",
};

const TOKEN_COLORS = {
  input: "#3b82f6", // blue
  output: "#6366f1", // indigo
  cacheCreate: "#ec4899", // pink
  cacheRead: "#06b6d4", // cyan
};

const usd = (n: number) => {
  if (n === 0) return "$0";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
};

const compactInt = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
};

export function AnalyticsRoot({ workspaceSlug, canManage }: Props) {
  const ws = useAnalyticsStore((s) => s.byWorkspace[workspaceSlug]);
  const load = useAnalyticsStore((s) => s.load);

  useEffect(() => {
    if (!canManage) return;
    void load(workspaceSlug);
  }, [canManage, workspaceSlug, load]);

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-zinc-500">
          Only workspace admins and owners can view usage analytics.
        </CardContent>
      </Card>
    );
  }

  const data = ws?.data ?? null;
  const prior = ws?.prior ?? null;
  const loading = ws?.loading ?? false;
  const error = ws?.error ?? null;
  const empty = !!data && data.totals.costUsdEstimate === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-zinc-400">
            Estimated spend, broken out by manual vs scheduled runs, agent,
            user, and model. Numbers are directional — reconcile against the
            BigQuery billing export before customer billing.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <RangePicker workspaceSlug={workspaceSlug} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!data || loading}
            onClick={() => {
              if (!data) return;
              const fn =
                `${workspaceSlug}-usage-${data.range.since}-to-${data.range.until}.csv`;
              downloadCsv(fn, rollupToCsv(data, workspaceSlug));
            }}
            className="h-8 gap-1.5 px-2 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-10 text-center text-sm text-zinc-500">
          Loading…
        </div>
      )}

      {data && (
        <>
          <KpiStrip data={data} prior={prior} preset={ws?.preset ?? null} />
          {empty ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-zinc-500">
                No agent runs in this date range yet.
              </CardContent>
            </Card>
          ) : (
            <>
              <DailySpendChart data={data} />
              <TokenVolumeChart data={data} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <CostCompositionDonut data={data} />
                <div className="lg:col-span-2">
                  <TopMoversPanel data={data} prior={prior} />
                </div>
              </div>
              <AgentDrilldownTable data={data} prior={prior} />
              <ModelBreakdownTable data={data} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────────

function KpiStrip({
  data,
  prior,
  preset,
}: {
  data: AnalyticsRollup;
  prior: AnalyticsRollup | null;
  preset: string | null;
}) {
  const t = data.totals;

  // Burn rate over the visible range. `until` is exclusive so subtract.
  const since = new Date(data.range.since);
  const until = new Date(data.range.until);
  const days = Math.max(1, Math.round(
    (until.getTime() - since.getTime()) / 86_400_000,
  ));
  const burnRate = t.costUsdEstimate / days;

  // Projected month-end only meaningful when the range is the current
  // month — anything else and the projection number doesn't reflect a
  // useful question. Skip on other presets.
  const isThisMonth = preset === "thisMonth";
  const now = new Date();
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  );
  const monthDays = monthEnd.getUTCDate();
  const projected = isThisMonth ? burnRate * monthDays : null;

  const activeAgents = data.byAgent.length;
  const activeUsers = data.byUser.length;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <KpiTile
        label="Total spend"
        value={usd(t.costUsdEstimate)}
        delta={prior ? deltaPct(t.costUsdEstimate, prior.totals.costUsdEstimate) : null}
        deltaPriorValue={prior ? usd(prior.totals.costUsdEstimate) : null}
        deltaInverse
      />
      <KpiTile
        label="Burn rate"
        value={`${usd(burnRate)}/day`}
        sub={`${days} day${days === 1 ? "" : "s"} in range`}
      />
      {isThisMonth && projected !== null ? (
        <KpiTile
          label={`Projected month`}
          value={usd(projected)}
          sub={`at current burn through ${monthEnd.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}`}
        />
      ) : (
        <KpiTile
          label="Cache savings"
          value={usd(t.cacheSavingsUsdEstimate ?? 0)}
          sub={
            t.costUsdEstimate > 0
              ? `${(((t.cacheSavingsUsdEstimate ?? 0) / (t.costUsdEstimate + (t.cacheSavingsUsdEstimate ?? 0))) * 100).toFixed(0)}% saved via prompt caching`
              : "no spend yet"
          }
        />
      )}
      <KpiTile
        label="Active agents"
        value={`${activeAgents}`}
        sub={
          prior !== null
            ? `${prior.byAgent.length} prior`
            : "agents producing tokens"
        }
      />
      <KpiTile
        label="Active users"
        value={`${activeUsers}`}
        sub={
          prior !== null
            ? `${prior.byUser.length} prior`
            : "manual session triggers"
        }
      />
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
  delta,
  deltaPriorValue,
  deltaInverse,
}: {
  label: string;
  value: string;
  sub?: string;
  /** -1..+1 fraction; null = no compare data. */
  delta?: number | null;
  deltaPriorValue?: string | null;
  /** When true (cost metrics), increases are framed as "bad" (rose). */
  deltaInverse?: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {label}
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <div className="text-lg font-semibold text-zinc-100">{value}</div>
          {delta !== null && delta !== undefined && (
            <DeltaBadge value={delta} inverse={!!deltaInverse} />
          )}
        </div>
        {sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}
        {deltaPriorValue && delta !== null && delta !== undefined && (
          <div className="mt-0.5 text-[11px] text-zinc-500">
            vs {deltaPriorValue} prior
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function deltaPct(current: number, prior: number): number | null {
  if (prior === 0) {
    if (current === 0) return 0;
    return null; // can't render "% vs zero"
  }
  return (current - prior) / prior;
}

function DeltaBadge({ value, inverse }: { value: number; inverse: boolean }) {
  // For cost: up = bad (rose), down = good (emerald). Volume / counts:
  // up = good. `inverse` flips the color mapping.
  const Icon =
    Math.abs(value) < 0.005 ? Minus : value > 0 ? ArrowUp : ArrowDown;
  const positive = value > 0.005;
  const negative = value < -0.005;
  const goodWhenUp = !inverse;
  const isGood = positive ? goodWhenUp : negative ? !goodWhenUp : true;
  const color = isGood ? "text-emerald-400" : "text-rose-400";
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${color}`}
    >
      <Icon className="size-3" />
      {Math.abs(value * 100).toFixed(0)}%
    </span>
  );
}

// ─── Daily spend (stacked bars) ───────────────────────────────────────

function DailySpendChart({ data }: { data: AnalyticsRollup }) {
  const series = useMemo(() => {
    const byDay = new Map<
      string,
      { day: string; user: number; scheduler: number; agent: number }
    >();
    for (const r of data.byDayByTriggerSource) {
      const cur =
        byDay.get(r.day) ?? { day: r.day, user: 0, scheduler: 0, agent: 0 };
      cur[r.triggeredBy] += r.costUsdEstimate;
      byDay.set(r.day, cur);
    }
    return Array.from(byDay.values()).sort((a, b) =>
      a.day.localeCompare(b.day),
    );
  }, [data.byDayByTriggerSource]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily spend</CardTitle>
        <CardDescription>
          Cost per day, stacked by trigger source. Hover a bar for the
          per-trigger breakdown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer>
            <BarChart
              data={series}
              margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#27272a"
                vertical={false}
              />
              <XAxis
                dataKey="day"
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={shortDay}
              />
              <YAxis
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={(v) => usd(Number(v))}
                width={50}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: "#e4e4e7" }}
                cursor={{ fill: "rgba(255,255,255,0.03)" }}
                formatter={(v: number, name: string) => [
                  usd(v),
                  TRIGGER_LABELS[name as TriggerSource] ?? name,
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                formatter={(name) =>
                  TRIGGER_LABELS[name as TriggerSource] ?? name
                }
              />
              <Bar
                dataKey="user"
                stackId="cost"
                fill={TRIGGER_COLORS.user}
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="scheduler"
                stackId="cost"
                fill={TRIGGER_COLORS.scheduler}
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="agent"
                stackId="cost"
                fill={TRIGGER_COLORS.agent}
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function shortDay(s: string): string {
  // 2026-04-15 → Apr 15 — only the unique-per-month part.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const month = new Date(Date.UTC(2000, parseInt(m[2]!, 10) - 1, 1))
    .toLocaleString(undefined, { month: "short", timeZone: "UTC" });
  return `${month} ${parseInt(m[3]!, 10)}`;
}

// ─── Token volume (stacked bars) ──────────────────────────────────────

function TokenVolumeChart({ data }: { data: AnalyticsRollup }) {
  const series = useMemo(
    () =>
      data.byDay.map((r) => ({
        day: r.day,
        input: r.inputTokens,
        output: r.outputTokens,
        cacheCreate: r.cacheCreationInputTokens,
        cacheRead: r.cacheReadInputTokens,
      })),
    [data.byDay],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token volume</CardTitle>
        <CardDescription>
          Daily token throughput by type. Cache reads are 10× cheaper
          than fresh input tokens, so this is the right chart to track
          AI adoption — they don't show up proportionally in the dollar
          chart above.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer>
            <BarChart
              data={series}
              margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#27272a"
                vertical={false}
              />
              <XAxis
                dataKey="day"
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={shortDay}
              />
              <YAxis
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={(v) => compactInt(Number(v))}
                width={50}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: "#e4e4e7" }}
                cursor={{ fill: "rgba(255,255,255,0.03)" }}
                formatter={(v: number, name: string) => [
                  compactInt(v),
                  tokenLabel(name),
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                formatter={tokenLabel}
              />
              <Bar dataKey="input" stackId="t" fill={TOKEN_COLORS.input} />
              <Bar dataKey="output" stackId="t" fill={TOKEN_COLORS.output} />
              <Bar
                dataKey="cacheCreate"
                stackId="t"
                fill={TOKEN_COLORS.cacheCreate}
              />
              <Bar
                dataKey="cacheRead"
                stackId="t"
                fill={TOKEN_COLORS.cacheRead}
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function tokenLabel(name: string): string {
  return (
    {
      input: "Input",
      output: "Output",
      cacheCreate: "Cache write",
      cacheRead: "Cache read",
    }[name] ?? name
  );
}

// ─── Cost composition donut ──────────────────────────────────────────

function CostCompositionDonut({ data }: { data: AnalyticsRollup }) {
  const slices = data.byTriggerSource.map((r) => ({
    name: TRIGGER_LABELS[r.triggeredBy],
    source: r.triggeredBy,
    value: r.costUsdEstimate,
  }));
  const total = slices.reduce((s, x) => s + x.value, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trigger mix</CardTitle>
        <CardDescription>Where the spend comes from.</CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius={55}
                outerRadius={85}
                paddingAngle={2}
                stroke="#09090b"
              >
                {slices.map((s, i) => (
                  <Cell key={i} fill={TRIGGER_COLORS[s.source]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number, name: string) => [
                  `${usd(v)} (${total > 0 ? ((v / total) * 100).toFixed(0) : 0}%)`,
                  name,
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 space-y-1">
          {slices.map((s) => (
            <div
              key={s.source}
              className="flex items-center justify-between text-xs"
            >
              <span className="flex items-center gap-2 text-zinc-300">
                <span
                  className="size-2.5 rounded-sm"
                  style={{ background: TRIGGER_COLORS[s.source] }}
                />
                {s.name}
              </span>
              <span className="tabular-nums text-zinc-400">
                {usd(s.value)}
                <span className="ml-2 text-zinc-600">
                  {total > 0 ? `${((s.value / total) * 100).toFixed(0)}%` : "—"}
                </span>
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Top movers ──────────────────────────────────────────────────────

function TopMoversPanel({
  data,
  prior,
}: {
  data: AnalyticsRollup;
  prior: AnalyticsRollup | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <MoversCard
        title="Top agents"
        subtitle={
          prior ? "Cost change vs prior period" : "Cost in the selected range"
        }
        rows={data.byAgent.slice(0, 6).map((a) => ({
          label: a.agentName ?? "(deleted)",
          sub: a.agentSlug ?? undefined,
          current: a.costUsdEstimate,
          prior:
            prior?.byAgent.find((p) => p.agentId === a.agentId)
              ?.costUsdEstimate ?? null,
        }))}
        emptyMessage="No agent activity in this range."
      />
      <MoversCard
        title="Top users"
        subtitle={
          prior
            ? "Manual sessions only · cost change vs prior"
            : "Manual sessions only · cost in the selected range"
        }
        rows={data.byUser.slice(0, 6).map((u) => ({
          label: u.userName ?? u.userEmail ?? "(deleted)",
          sub: u.userEmail ?? undefined,
          current: u.costUsdEstimate,
          prior:
            prior?.byUser.find((p) => p.userId === u.userId)
              ?.costUsdEstimate ?? null,
        }))}
        emptyMessage="No manual sessions in this range."
      />
    </div>
  );
}

function MoversCard({
  title,
  subtitle,
  rows,
  emptyMessage,
}: {
  title: string;
  subtitle: string;
  rows: {
    label: string;
    sub?: string;
    current: number;
    prior: number | null;
  }[];
  emptyMessage: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">
            {emptyMessage}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-900">
            {rows.map((r, i) => {
              const delta = r.prior !== null ? deltaPct(r.current, r.prior) : null;
              const max = Math.max(...rows.map((x) => x.current), 1);
              return (
                <li key={i} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-zinc-100">
                        {r.label}
                      </div>
                      {r.sub && (
                        <div className="truncate text-[11px] text-zinc-500">
                          {r.sub}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-baseline gap-2">
                      <span className="text-sm tabular-nums text-zinc-100">
                        {usd(r.current)}
                      </span>
                      {delta !== null && (
                        <DeltaBadge value={delta} inverse={true} />
                      )}
                    </div>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-900">
                    <div
                      className="h-full rounded-full bg-zinc-400/70"
                      style={{ width: `${(r.current / max) * 100}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Per-agent drilldown table ───────────────────────────────────────

type AgentSortKey = "cost" | "input" | "output" | "delta";

function AgentDrilldownTable({
  data,
  prior,
}: {
  data: AnalyticsRollup;
  prior: AnalyticsRollup | null;
}) {
  const [sort, setSort] = useState<AgentSortKey>("cost");

  const rows = useMemo(() => {
    const enriched = data.byAgent.map((a: TokenUsageByAgent) => {
      const priorMatch = prior?.byAgent.find((p) => p.agentId === a.agentId);
      const priorCost = priorMatch?.costUsdEstimate ?? null;
      const delta = priorCost !== null ? deltaPct(a.costUsdEstimate, priorCost) : null;
      return { agent: a, priorCost, delta };
    });
    enriched.sort((a, b) => {
      switch (sort) {
        case "cost":
          return b.agent.costUsdEstimate - a.agent.costUsdEstimate;
        case "input":
          return b.agent.inputTokens - a.agent.inputTokens;
        case "output":
          return b.agent.outputTokens - a.agent.outputTokens;
        case "delta":
          return (b.delta ?? 0) - (a.delta ?? 0);
      }
    });
    return enriched;
  }, [data.byAgent, prior, sort]);

  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <CardDescription>
          Per-agent breakdown for the selected range. Click a column to sort.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Agent</TableHead>
              <SortHead label="Cost" k="cost" sort={sort} setSort={setSort} />
              {prior && (
                <SortHead label="vs prior" k="delta" sort={sort} setSort={setSort} />
              )}
              <SortHead label="Input" k="input" sort={sort} setSort={setSort} />
              <SortHead label="Output" k="output" sort={sort} setSort={setSort} />
              <TableHead className="text-right">Cache write</TableHead>
              <TableHead className="text-right">Cache read</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ agent, delta }, i) => (
              <TableRow key={agent.agentId ?? `null-${i}`}>
                <TableCell className="px-4">
                  <div className="font-medium text-zinc-100">
                    {agent.agentName ?? "(deleted)"}
                  </div>
                  {agent.agentSlug && (
                    <div className="text-[11px] text-zinc-500">
                      {agent.agentSlug}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(agent.costUsdEstimate)}
                </TableCell>
                {prior && (
                  <TableCell className="text-right tabular-nums">
                    {delta !== null ? (
                      <DeltaBadge value={delta} inverse={true} />
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </TableCell>
                )}
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(agent.inputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(agent.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(agent.cacheCreationInputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(agent.cacheReadInputTokens)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SortHead({
  label,
  k,
  sort,
  setSort,
}: {
  label: string;
  k: AgentSortKey;
  sort: AgentSortKey;
  setSort: (k: AgentSortKey) => void;
}) {
  const isActive = sort === k;
  return (
    <TableHead
      className={`cursor-pointer text-right select-none ${isActive ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
      onClick={() => setSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive && <ArrowDown className="size-3" />}
      </span>
    </TableHead>
  );
}

// ─── Per-model breakdown ─────────────────────────────────────────────

function ModelBreakdownTable({ data }: { data: AnalyticsRollup }) {
  if (data.byModel.length === 0) return null;
  const total = data.totals.costUsdEstimate || 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>By model</CardTitle>
        <CardDescription>
          Tier dispatch is by substring of the model id; per-model price
          overrides live in Platform admin → Claude models.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4">Model</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Cache W</TableHead>
              <TableHead className="text-right">Cache R</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.byModel.map((r) => (
              <TableRow key={r.model}>
                <TableCell className="font-mono text-xs px-4">
                  {r.model}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(r.costUsdEstimate)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {((r.costUsdEstimate / total) * 100).toFixed(0)}%
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(r.inputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(r.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(r.cacheCreationInputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-400">
                  {compactInt(r.cacheReadInputTokens)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: "#0a0a0a",
  border: "1px solid #27272a",
  borderRadius: 6,
  fontSize: 12,
  padding: "8px 10px",
};
