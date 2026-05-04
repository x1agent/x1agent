import { useEffect } from "react";
import { useImagesStore, type AgentImage } from "../../stores/imagesStore";
import { useUrlSearchParam } from "../../lib/useUrlSearchParam";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
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

export function ContainerRegistryPanel({ slug }: Props) {
  const { bySlug, loadingSlug, errorBySlug, load } = useImagesStore();
  const images = bySlug[slug] ?? [];
  const loading = loadingSlug === slug && images.length === 0;
  const error = errorBySlug[slug] ?? null;

  // URL-synced selection. Click a row → `?image=<id>`; Back in the
  // browser clears it. Deep-linking into an image row works.
  const [selectedId, setSelectedId] = useUrlSearchParam("image", "");

  useEffect(() => {
    load(slug);
  }, [slug, load]);

  const selected = selectedId
    ? images.find((i) => i.id === selectedId) ?? null
    : null;

  if (selected) {
    return <ImageDetail image={selected} onBack={() => setSelectedId("")} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Container registry</CardTitle>
        <CardDescription>
          Images an agent in this workspace can run in. Platform presets
          are available to every workspace. Workspace-authored images
          (Dockerfile editor in this UI) land here once Phase 2 of the
          image catalog ships.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && <div className="text-sm text-fg-muted">Loading…</div>}
        {error && <div className="text-sm text-red-400">{error}</div>}

        {images.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border-soft">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Kind</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {images.map((img) => (
                  <TableRow
                    key={img.id}
                    onClick={() => setSelectedId(img.id)}
                    className="cursor-pointer transition-colors hover:bg-bg"
                  >
                    <TableCell className="text-fg font-medium">
                      {img.display_name}
                      <div className="font-mono text-xs text-fg-faint">
                        {img.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-fg-muted text-xs max-w-md">
                      {img.description ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={img.is_preset ? "info" : "secondary"}>
                        {img.is_preset ? "preset" : "workspace"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {!loading && !error && images.length === 0 && (
          <div className="rounded-md border border-border-soft p-6 text-center text-sm text-fg-faint">
            No images available. The seed should populate platform
            presets on api boot; if you're seeing this, check the api
            logs for a <code>[seed] platform presets ready</code> line.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ImageDetail({
  image,
  onBack,
}: {
  image: AgentImage;
  onBack: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle>{image.display_name}</CardTitle>
              <Badge variant={image.is_preset ? "info" : "secondary"}>
                {image.is_preset ? "preset" : "workspace"}
              </Badge>
            </div>
            <div className="mt-1 font-mono text-xs text-fg-faint">
              {image.name}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="text-xs text-fg-muted"
          >
            ← Back
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {image.description && (
          <section>
            <SectionLabel>Description</SectionLabel>
            <p className="text-fg-muted">{image.description}</p>
          </section>
        )}

        <section>
          <SectionLabel>Dockerfile</SectionLabel>
          {image.dockerfile_source ? (
            <pre className="max-h-[28rem] overflow-auto rounded-md bg-bg p-3 font-mono text-xs text-fg whitespace-pre-wrap break-all border border-border-soft">
              {image.dockerfile_source}
            </pre>
          ) : (
            <div className="rounded-md border border-border-soft p-3 text-xs text-fg-faint">
              Dockerfile source isn't stored on this row. For seeded
              presets this should populate automatically on the next
              api restart; check the <code>[seed] platform presets
              ready</code> log line.
            </div>
          )}
          {image.is_preset && (
            <p className="mt-1 text-xs text-fg-faint">
              Presets are code-maintained in{" "}
              <code>deploy/images/{image.name.replace(/^preset-/, "")}/Dockerfile</code>
              . Edits happen in the repo and ship with{" "}
              <code>mise run images:publish</code>. Forking a preset
              into a workspace-scoped, editable image is the next arc.
            </p>
          )}
        </section>

        <section>
          <SectionLabel>Registry reference</SectionLabel>
          <div className="rounded-md bg-bg px-3 py-2 font-mono text-xs text-fg break-all">
            {image.built_ref}
          </div>
        </section>

        <section className="grid grid-cols-2 gap-4">
          <Field
            label="Scope"
            value={
              image.is_preset
                ? "Platform preset (every workspace)"
                : "Workspace-scoped"
            }
          />
          <Field
            label="Build status"
            value={
              <Badge
                variant={
                  image.build_status === "ready" ||
                  image.build_status === "succeeded"
                    ? "success"
                    : image.build_status === "failed"
                      ? "warning"
                      : "info"
                }
              >
                {image.build_status}
              </Badge>
            }
          />
          <Field
            label="Created"
            value={new Date(image.created_at).toLocaleString()}
          />
          <Field
            label="Last built"
            value={
              image.last_built_at
                ? new Date(image.last_built_at).toLocaleString()
                : "—"
            }
          />
        </section>

        {image.build_status === "failed" && image.build_log && (
          <section>
            <SectionLabel>Build log</SectionLabel>
            <pre className="max-h-[20rem] overflow-auto rounded-md bg-bg p-3 font-mono text-xs text-red-300 whitespace-pre-wrap border border-border-soft">
              {image.build_log}
            </pre>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-wide text-fg-faint mb-1">
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="text-fg-muted">{value}</div>
    </div>
  );
}
