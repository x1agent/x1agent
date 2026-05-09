# packages/app

Astro + React + zustand + Tailwind v4 frontend. Read the root `CLAUDE.md` first — this file only covers app-specific conventions.

## State management

See "Frontend state management" in the root `CLAUDE.md`. tl;dr: zustand stores in `src/stores/`, components consume them through stable selectors, components never call `apiFetch` directly.

## Component testing

Component tests live in `src/__tests__/` and run under `bun test`. Pure React components (no DOM event handlers under test) can be exercised via `react-dom/server` `renderToString` plus regex assertions on the markup — no happy-dom needed for that case. Anything that simulates clicks / typing should add the React Testing Library + happy-dom setup before merging.

## Use `truncate` / `text-overflow: ellipsis` on text inside containers that need to shrink

Any text-bearing element inside a flex / grid row that can shrink under narrow viewports — page titles, breadcrumb segments, session summaries, tool-call labels, agent names in pickers — MUST use Tailwind's `truncate` utility (or an equivalent `overflow-hidden text-ellipsis whitespace-nowrap` triple) and live inside a `min-w-0` parent.

Without `min-w-0`, flex children default to `min-width: auto` (their content min-width), which means a long string makes the whole row overflow horizontally and pushes neighbouring controls (Resume / Verbose / status pill) off-screen on narrow widths. Symptom: a pixel-perfect layout in Chrome at 1440px that completely breaks at 1024px or on a sidecar pane.

The pattern:

```tsx
<div className="flex min-w-0 items-center gap-3">
  <span className="truncate" title={fullText}>{fullText}</span>
  <span className="shrink-0">…neighbour…</span>
</div>
```

Always set `title={fullText}` so hover reveals the full content on desktop. Mobile users get the truncated version; that's acceptable for a header but not for primary content — when the field is the user's main read, render it with `whitespace-pre-wrap` and let the row grow vertically instead.

This rule was promoted from "tribal knowledge" to a written one after the X1A-7 session-summary work — long LLM-generated summaries pushed the Resume button off-screen until `truncate` was applied.
