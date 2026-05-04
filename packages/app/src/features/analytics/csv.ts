import type { AnalyticsRollup } from "../../stores/analyticsStore";

/**
 * Build a single CSV that captures every dimension breakdown the
 * dashboard renders, with section banners between dimensions so the
 * resulting file is pivot-friendly in Excel / Sheets / DuckDB.
 *
 * One CSV instead of one per panel because executives want to slice
 * the same data lots of ways without re-uploading.
 */
export function rollupToCsv(rollup: AnalyticsRollup, label: string): string {
  const lines: string[] = [];
  const push = (cols: (string | number)[]) =>
    lines.push(cols.map(escapeCell).join(","));

  push([`# Workspace token usage analytics — ${label}`]);
  push([
    `# Range: ${rollup.range.since} to ${rollup.range.until} (UTC, end exclusive)`,
  ]);
  push([`# Generated: ${new Date().toISOString()}`]);
  push([]);

  // ── Totals ───────────────────────────────────────────────────────
  push(["section", "metric", "value"]);
  push(["totals", "cost_usd_estimate", rollup.totals.costUsdEstimate]);
  push([
    "totals",
    "cache_savings_usd_estimate",
    rollup.totals.cacheSavingsUsdEstimate ?? 0,
  ]);
  push(["totals", "input_tokens", rollup.totals.inputTokens]);
  push(["totals", "output_tokens", rollup.totals.outputTokens]);
  push([
    "totals",
    "cache_creation_input_tokens",
    rollup.totals.cacheCreationInputTokens,
  ]);
  push([
    "totals",
    "cache_read_input_tokens",
    rollup.totals.cacheReadInputTokens,
  ]);
  push([]);

  // ── By trigger source ────────────────────────────────────────────
  push(["by_trigger_source"]);
  push(["triggered_by", "cost_usd", "input", "output", "cache_create", "cache_read"]);
  for (const r of rollup.byTriggerSource) {
    push([
      r.triggeredBy,
      r.costUsdEstimate,
      r.inputTokens,
      r.outputTokens,
      r.cacheCreationInputTokens,
      r.cacheReadInputTokens,
    ]);
  }
  push([]);

  // ── By agent ─────────────────────────────────────────────────────
  push(["by_agent"]);
  push([
    "agent_name",
    "agent_slug",
    "cost_usd",
    "input",
    "output",
    "cache_create",
    "cache_read",
  ]);
  for (const r of rollup.byAgent) {
    push([
      r.agentName ?? "(deleted agent)",
      r.agentSlug ?? "",
      r.costUsdEstimate,
      r.inputTokens,
      r.outputTokens,
      r.cacheCreationInputTokens,
      r.cacheReadInputTokens,
    ]);
  }
  push([]);

  // ── By user ──────────────────────────────────────────────────────
  push(["by_user (manual sessions only)"]);
  push([
    "user_name",
    "user_email",
    "cost_usd",
    "input",
    "output",
    "cache_create",
    "cache_read",
  ]);
  for (const r of rollup.byUser) {
    push([
      r.userName ?? "(deleted user)",
      r.userEmail ?? "",
      r.costUsdEstimate,
      r.inputTokens,
      r.outputTokens,
      r.cacheCreationInputTokens,
      r.cacheReadInputTokens,
    ]);
  }
  push([]);

  // ── By model ─────────────────────────────────────────────────────
  push(["by_model"]);
  push(["model", "cost_usd", "input", "output", "cache_create", "cache_read"]);
  for (const r of rollup.byModel) {
    push([
      r.model,
      r.costUsdEstimate,
      r.inputTokens,
      r.outputTokens,
      r.cacheCreationInputTokens,
      r.cacheReadInputTokens,
    ]);
  }
  push([]);

  // ── Daily by trigger ─────────────────────────────────────────────
  // Most pivot-friendly cut — one row per (day × triggered_by). Lets
  // the operator drop into a pivot table and slice however they want.
  push(["daily_by_trigger"]);
  push([
    "day",
    "triggered_by",
    "cost_usd",
    "input",
    "output",
    "cache_create",
    "cache_read",
  ]);
  for (const r of rollup.byDayByTriggerSource) {
    push([
      r.day,
      r.triggeredBy,
      r.costUsdEstimate,
      r.inputTokens,
      r.outputTokens,
      r.cacheCreationInputTokens,
      r.cacheReadInputTokens,
    ]);
  }

  return lines.join("\n");
}

function escapeCell(v: string | number): string {
  const s = typeof v === "number" ? String(v) : v;
  // Wrap and escape only when necessary — keeps numeric-only rows
  // un-quoted so spreadsheet apps treat them as numbers, not strings.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Trigger a download from the browser. No network — the CSV is
 * generated client-side from already-loaded data.
 */
export function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so browsers that defer the download finish first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
