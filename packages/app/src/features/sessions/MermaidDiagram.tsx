import { useEffect, useState } from "react";

let initialized = false;

export function MermaidDiagram({ content }: { content: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        if (!initialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            securityLevel: "loose",
            fontFamily: "system-ui, sans-serif",
          });
          initialized = true;
        }
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg: rendered } = await mermaid.render(id, content.trim());
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-md bg-bg-elevated p-3 text-xs text-fg-muted">
        {content}
      </pre>
    );
  }
  if (!svg) {
    return (
      <div className="py-3 text-center text-xs text-fg-faint">
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="overflow-x-auto rounded-md border border-border-soft bg-bg-elevated p-3 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
