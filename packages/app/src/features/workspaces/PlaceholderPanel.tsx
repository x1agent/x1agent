import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";

interface Props {
  title: string;
  /** One-line summary of what this section will eventually contain. */
  summary: string;
  /** Bullet list of the specific capabilities planned. */
  capabilities: readonly string[];
}

/**
 * Empty-but-promised settings page. Surfaces the IA so operators
 * know where the feature will land when it ships, without trying
 * to fake a fake UI.
 */
export function PlaceholderPanel({ title, summary, capabilities }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          <span className="rounded-sm bg-bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
            Coming soon
          </span>
        </CardTitle>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5 text-sm text-fg-muted">
          {capabilities.map((c, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-zinc-600" />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
