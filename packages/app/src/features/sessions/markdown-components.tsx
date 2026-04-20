/**
 * Shared react-markdown overrides. Every place that renders Markdown
 * inside a session stream (AgentText, ArtifactCard, ShareCard's
 * DocumentShare) routes through these overrides so the styling is
 * identical regardless of origin.
 *
 * Why this file exists: react-markdown emits unstyled HTML by default,
 * and we intentionally don't ship @tailwindcss/typography. These
 * overrides cover the ~15 element types we care about and nothing
 * else.
 *
 * Design priorities:
 *   1. Compressed vertical scale — this renders inline in a scrolling
 *      event list, not as a standalone page. Headings are sized down
 *      relative to normal defaults while keeping a clear hierarchy.
 *   2. Minimal chrome — subtle outlines on tables and code blocks,
 *      whitespace-driven section breaks, no heavy contrast.
 *   3. Dark theme only — x1agent's app is dark-only, so there's no
 *      color-scheme switch to maintain.
 *
 * Pass to `<Markdown components={markdownComponents} />`.
 */
import type { ComponentProps, JSX, ReactNode } from "react";
import { MermaidDiagram } from "./MermaidDiagram";

type Props<T extends keyof JSX.IntrinsicElements> = ComponentProps<T> & {
  children?: ReactNode;
};

export const markdownComponents = {
  // ── Headings — 18/16/14/11/11/11px down the scale.
  h1: ({ children, ...rest }: Props<"h1">) => (
    <h1
      className="mt-6 mb-2 text-lg font-semibold tracking-tight text-zinc-100 first:mt-0"
      {...rest}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...rest }: Props<"h2">) => (
    <h2
      className="mt-5 mb-1.5 text-base font-semibold tracking-tight text-zinc-100 first:mt-0"
      {...rest}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...rest }: Props<"h3">) => (
    <h3
      className="mt-4 mb-1 text-sm font-semibold tracking-tight text-zinc-200 first:mt-0"
      {...rest}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...rest }: Props<"h4">) => (
    <h4
      className="mt-4 mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 first:mt-0"
      {...rest}
    >
      {children}
    </h4>
  ),
  h5: ({ children, ...rest }: Props<"h5">) => (
    <h5
      className="mt-3 mb-1 text-[11px] font-semibold text-zinc-400 first:mt-0"
      {...rest}
    >
      {children}
    </h5>
  ),
  h6: ({ children, ...rest }: Props<"h6">) => (
    <h6
      className="mt-3 mb-1 text-[11px] font-medium text-zinc-500 first:mt-0"
      {...rest}
    >
      {children}
    </h6>
  ),

  // ── Paragraphs — ~8px top/bottom, 1.625 line-height.
  p: ({ children, ...rest }: Props<"p">) => (
    <p className="my-2 leading-relaxed first:mt-0 last:mb-0" {...rest}>
      {children}
    </p>
  ),

  // ── Lists — 24px indent, tight item spacing, muted markers.
  ul: ({ children, ...rest }: Props<"ul">) => (
    <ul
      className="my-2 list-outside list-disc space-y-1 pl-6 marker:text-zinc-500 first:mt-0 last:mb-0"
      {...rest}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...rest }: Props<"ol">) => (
    <ol
      className="my-2 list-outside list-decimal space-y-1 pl-6 marker:text-zinc-500 first:mt-0 last:mb-0"
      {...rest}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...rest }: Props<"li">) => (
    <li
      className="leading-relaxed [&>ol]:my-1 [&>p]:my-0 [&>ul]:my-1"
      {...rest}
    >
      {children}
    </li>
  ),

  // ── Inline.
  strong: ({ children, ...rest }: Props<"strong">) => (
    <strong className="font-semibold" {...rest}>
      {children}
    </strong>
  ),
  em: ({ children, ...rest }: Props<"em">) => (
    <em className="italic" {...rest}>
      {children}
    </em>
  ),
  a: ({ children, href, ...rest }: Props<"a">) => (
    <a
      href={href}
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
      className="text-blue-400 underline decoration-blue-400/40 underline-offset-2 hover:decoration-blue-400"
      {...rest}
    >
      {children}
    </a>
  ),

  blockquote: ({ children, ...rest }: Props<"blockquote">) => (
    <blockquote
      className="my-3 border-l-2 border-zinc-800 pl-3 italic text-zinc-400 first:mt-0 last:mb-0"
      {...rest}
    >
      {children}
    </blockquote>
  ),

  // ── Code — block vs inline distinguished by presence of language-*.
  // Mermaid fences render as diagrams via MermaidDiagram.
  code({
    className,
    children,
    ...rest
  }: ComponentProps<"code"> & { className?: string; children?: ReactNode }) {
    const match = /language-(\w+)/.exec(className || "");
    const lang = match?.[1];
    if (lang === "mermaid") {
      return <MermaidDiagram content={String(children).trim()} />;
    }
    if (!lang) {
      return (
        <code
          className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.85em] text-zinc-100"
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...rest }: Props<"pre">) => (
    <pre
      className="my-3 overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100 first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-zinc-100"
      {...rest}
    >
      {children}
    </pre>
  ),

  // ── Tables — bordered wrapper, tinted header, subtle row dividers.
  table: ({ children, ...rest }: Props<"table">) => (
    <div className="my-4 overflow-x-auto rounded-md border border-zinc-800 first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-xs" {...rest}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...rest }: Props<"thead">) => (
    <thead className="border-b border-zinc-800 bg-zinc-900/50" {...rest}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...rest }: Props<"tbody">) => (
    <tbody {...rest}>{children}</tbody>
  ),
  tr: ({ children, ...rest }: Props<"tr">) => (
    <tr className="border-b border-zinc-800/40 last:border-0" {...rest}>
      {children}
    </tr>
  ),
  th: ({ children, ...rest }: Props<"th">) => (
    <th
      className="px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-400"
      {...rest}
    >
      {children}
    </th>
  ),
  td: ({ children, ...rest }: Props<"td">) => (
    <td className="px-2.5 py-1.5 align-top" {...rest}>
      {children}
    </td>
  ),

  // ── Horizontal rule — barely-visible line + big margin so it reads
  // as a section break without a heavy divider.
  hr: (props: Props<"hr">) => (
    <hr className="my-4 border-0 border-t border-zinc-800/30" {...props} />
  ),
};
