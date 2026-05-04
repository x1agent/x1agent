import { useEffect, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
import {
  useAnalyticsStore,
  type AnalyticsRollup,
  type TriggerSource,
} from "../../stores/analyticsStore";
import { RangePicker } from "./RangePicker";

interface Props {
  workspaceSlug: string;
  canManage: boolean;
}

const TRIGGER_COLORS: Record<TriggerSource, string> = {
  user: "#22c55e", // emerald — humans
  scheduler: "#f59e0b", // amber — cron
  agent: "#8b5cf6", // violet — orchestrator-spawned
};
const TRIGGER_LABELS: Record<TriggerSource, string> = {
  user: "Manual",
  scheduler: "Scheduled",
  agent: "Agent-spawned",
};

const usd = (n: number) =>
  n >= 100
    ? `$${n.toFixed(0)}`
    : n >= 1
      ? `$${n.toFixed(2)}`
      : `$${n.toFixed(4)}`;

const compactInt = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : `${n}`;

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
  const loading = ws?.loading ?? false;
  const error = ws?.error ?? null;
  const empty = !!data && data.totals.costUsdEstimate === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Usage analytics</h2>
          <p className="text-sm text-zinc-500">
            Estimated spend, broken out by manual vs scheduled runs, agents,
            users, and models. Costs are directional — reconcile against the
            BigQuery billing export before charging customers.
          </p>
        </div>
        <RangePicker workspaceSlug={workspaceSlug} />
      </div>

      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-sm text-zinc-500">Loading…</div>
      )}

      {data && (
        <>
          <KpiCards data={data} />
          {empty ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-zinc-500">
                No agent runs in this date range yet.
              </CardContent>
            </Card>
          ) : (
            <>
              <DailyCostChart data={data} />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <TriggerSourcePanel data={data} />
                <TopAgentsPanel data={data} />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <TopUsersPanel data={data} />
                <ByModelPanel data={data} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function KpiCards({ data }: { data: AnalyticsRollup }) {
  const t = data.totals;
  const cacheReadShare =
    t.inputTokens + t.cacheReadInputTokens + t.cacheCreationInputTokens > 0
      ? t.cacheReadInputTokens /
        (t.inputTokens + t.cacheReadInputTokens + t.cacheCreationInputTokens)
      : 0;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiTile label="Estimated cost" value={usd(t.costUsdEstimate)} />
      <KpiTile
        label="Input tokens"
        value={compactInt(t.inputTokens)}
        sub={`+${compactInt(t.cacheCreationInputTokens)} cached, ${compactInt(t.cacheReadInputTokens)} reused`}
      />
      <KpiTile label="Output tokens" value={compactInt(t.outputTokens)} />
      <KpiTile
        label="Cache hit"
        value={`${(cacheReadShare * 100).toFixed(1)}%`}
        sub="of prompt tokens served from cache"
      />
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
          {label}
        </div>
        <div className="mt-0.5 text-lg font-semibold text-zinc-100">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * Daily cost stacked-area chart by trigger source. Recharts wants an
 * array of `{ day, user, scheduler, agent }` objects; we pivot the
 * server's long-form `byDayByTriggerSource` here. Days with zero in
 * a bucket get explicit 0 so the stacking renders cleanly.
 */
function DailyCostChart({ data }: { data: AnalyticsRollup }) {
  const series = useMemo(() => {
    const byDay = new Map<
      string,
      { day: string; user: number; scheduler: number; agent: number }
    >();
    for (const r of data.byDayByTriggerSource) {
      const cur =
        byDay.get(r.day) ??
        ({ day: r.day, user: 0, scheduler: 0, agent: 0 } as const);
      byDay.set(r.day, {
        ...cur,
        [r.triggeredBy]: cur[r.triggeredBy] + r.costUsdEstimate,
      });
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
          Cost over time, stacked by trigger source so you can see the
          human-vs-automated split at a glance.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer>
            <AreaChart
              data={series}
              margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                dataKey="day"
                tick={{ fill: "#71717a", fontSize: 11 }}
                stroke="#3f3f46"
              />
              <YAxis
                tick={{ fill: "#71717a", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={(v) => usd(Number(v))}
              />
              <Tooltip
                contentStyle={{
                  background: "#09090b",
                  border: "1px solid #27272a",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#d4d4d8" }}
                formatter={(v: number, name: string) => [
                  usd(v),
                  TRIGGER_LABELS[name as TriggerSource] ?? name,
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
                formatter={(name) =>
                  TRIGGER_LABELS[name as TriggerSource] ?? name
                }
              />
              <Area
                type="monotone"
                dataKey="user"
                stackId="1"
                stroke={TRIGGER_COLORS.user}
                fill={TRIGGER_COLORS.user}
                fillOpacity={0.35}
              />
              <Area
                type="monotone"
                dataKey="scheduler"
                stackId="1"
                stroke={TRIGGER_COLORS.scheduler}
                fill={TRIGGER_COLORS.scheduler}
                fillOpacity={0.35}
              />
              <Area
                type="monotone"
                dataKey="agent"
                stackId="1"
                stroke={TRIGGER_COLORS.agent}
                fill={TRIGGER_COLORS.agent}
                fillOpacity={0.35}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function TriggerSourcePanel({ data }: { data: AnalyticsRollup }) {
  const rows = data.byTriggerSource;
  const total = rows.reduce((s, r) => s + r.costUsdEstimate, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual vs automated</CardTitle>
        <CardDescription>
          Spend split by what kicked off the session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <BarChart
              data={rows.map((r) => ({
                label: TRIGGER_LABELS[r.triggeredBy],
                cost: r.costUsdEstimate,
                source: r.triggeredBy,
              }))}
              layout="vertical"
              margin={{ top: 8, right: 16, bottom: 0, left: 60 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                type="number"
                tick={{ fill: "#71717a", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={(v) => usd(Number(v))}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                stroke="#3f3f46"
              />
              <Tooltip
                contentStyle={{
                  background: "#09090b",
                  border: "1px solid #27272a",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(v: number) => [
                  `${usd(v)} (${total > 0 ? ((v / total) * 100).toFixed(0) : 0}%)`,
                  "Cost",
                ]}
              />
              <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                {rows.map((r, i) => (
                  <Cell key={i} fill={TRIGGER_COLORS[r.triggeredBy]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function TopAgentsPanel({ data }: { data: AnalyticsRollup }) {
  const top = data.byAgent.slice(0, 8).map((r) => ({
    label: r.agentName ?? "(deleted agent)",
    cost: r.costUsdEstimate,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top agents</CardTitle>
        <CardDescription>Spend by agent in the selected range.</CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ width: "100%", height: 240 }}>
          <ResponsiveContainer>
            <BarChart
              data={top}
              layout="vertical"
              margin={{ top: 8, right: 16, bottom: 0, left: 100 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                type="number"
                tick={{ fill: "#71717a", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={(v) => usd(Number(v))}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                stroke="#3f3f46"
                width={110}
              />
              <Tooltip
                contentStyle={{
                  background: "#09090b",
                  border: "1px solid #27272a",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(v: number) => [usd(v), "Cost"]}
              />
              <Bar dataKey="cost" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function TopUsersPanel({ data }: { data: AnalyticsRollup }) {
  const top = data.byUser.slice(0, 8).map((r) => ({
    label: r.userName ?? r.userEmail ?? "(deleted user)",
    cost: r.costUsdEstimate,
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top users</CardTitle>
        <CardDescription>
          Manual sessions only. Scheduler / agent-spawned runs have no
          user attribution.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">
            No manual sessions in this range.
          </div>
        ) : (
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer>
              <BarChart
                data={top}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 0, left: 100 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                  type="number"
                  tick={{ fill: "#71717a", fontSize: 11 }}
                  stroke="#3f3f46"
                  tickFormatter={(v) => usd(Number(v))}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: "#a1a1aa", fontSize: 11 }}
                  stroke="#3f3f46"
                  width={110}
                />
                <Tooltip
                  contentStyle={{
                    background: "#09090b",
                    border: "1px solid #27272a",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(v: number) => [usd(v), "Cost"]}
                />
                <Bar dataKey="cost" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ByModelPanel({ data }: { data: AnalyticsRollup }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>By model</CardTitle>
        <CardDescription>
          Per-tier spend across the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
            {data.byModel.map((r) => (
              <TableRow key={r.model}>
                <TableCell className="font-mono text-xs">{r.model}</TableCell>
                <TableCell className="text-right">
                  {usd(r.costUsdEstimate)}
                </TableCell>
                <TableCell className="text-right text-zinc-400">
                  {compactInt(r.inputTokens)}
                </TableCell>
                <TableCell className="text-right text-zinc-400">
                  {compactInt(r.outputTokens)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
