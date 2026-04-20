import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { Badge } from "../../components/ui/badge";
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

interface Props {
  slug: string;
}

interface AgentImage {
  id: string;
  workspace_id: string | null;
  name: string;
  display_name: string;
  description: string | null;
  built_ref: string;
  is_preset: boolean;
}

/**
 * Read-only listing of the container images this workspace can pick
 * from. Platform presets (workspace_id = NULL) show up with a "preset"
 * badge. Workspace-authored images (Phase 2) will render here with
 * build status + a rebuild action when that surface lands.
 */
export function ContainerRegistryPanel({ slug }: Props) {
  const [images, setImages] = useState<AgentImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    apiFetch<{ images: AgentImage[] }>(
      `/api/workspaces/${slug}/agent-images`,
    )
      .then((body) => setImages(body.images ?? []))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [slug]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Container registry</CardTitle>
        <CardDescription>
          Images an agent in this workspace can run in. Platform presets
          are available to every workspace. Workspace-authored images
          (authored via a Dockerfile in this UI) land here once Phase 2
          of the image catalog ships.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <div className="text-sm text-zinc-400">Loading…</div>}
        {error && <div className="text-sm text-red-400">{error}</div>}

        {images.length > 0 && (
          <div className="overflow-hidden rounded-md border border-zinc-900">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Reference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {images.map((img) => (
                  <TableRow key={img.id} className="hover:bg-transparent">
                    <TableCell className="text-zinc-200 font-medium">
                      {img.display_name}
                    </TableCell>
                    <TableCell className="text-zinc-400 text-xs max-w-sm">
                      {img.description ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={img.is_preset ? "info" : "secondary"}
                      >
                        {img.is_preset ? "preset" : "workspace"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-zinc-500 text-xs font-mono">
                      {img.built_ref}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!loading && !error && images.length === 0 && (
          <div className="rounded-md border border-zinc-900 p-6 text-center text-sm text-zinc-500">
            No images available. The seed should populate platform
            presets on api boot; if you're seeing this, check the api
            logs for a `[seed] platform presets ready` line.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
